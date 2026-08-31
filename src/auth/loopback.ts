/**
 * Loopback redirect receiver for the desktop OAuth flow (RFC 8252 §7.3).
 *
 * YouVersion's flow needs three browser hops, and the middle one is unusual:
 * after consent the browser lands on our redirect URI carrying `state` *only*.
 * The docs require replaying that state to `/auth/callback` as a top-level
 * navigation, because a `fetch` cannot read the `Location` of a redirect. We
 * satisfy that by answering the first hit with a 302 to `/auth/callback`, which
 * then 302s back to us with the authorization code. The browser does the
 * navigating; we never handle the user's credentials or session cookies.
 *
 * Desktop only: `node:http` is unavailable in Obsidian mobile.
 */
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { redactError } from "../security/redact";

export interface LoopbackResult {
  code: string;
  state: string;
  grantedPermissions: string[];
}

export interface LoopbackOptions {
  port: number;
  /** Path component of the registered redirect URI, e.g. `/callback`. */
  path: string;
  /** Absolute URL of the upstream `/auth/callback` endpoint for the state replay. */
  replayEndpoint: string;
  /** The `state` we generated; anything else is rejected without being processed. */
  expectedState: string;
  timeoutMs: number;
}

export interface LoopbackHandle {
  /** Resolves with the authorization code, or rejects on denial/timeout/cancel. */
  readonly result: Promise<LoopbackResult>;
  /** Idempotent. Always call this, including on the success path. */
  close(): Promise<void>;
}

/**
 * Load `node:http` lazily, at the moment a sign-in actually starts.
 *
 * This must be `require`, not `await import`. The plugin is bundled as CommonJS
 * with Node builtins left external, and esbuild emits a dynamic `import()`
 * verbatim - so in Obsidian's Electron renderer it becomes a real ESM import
 * that the browser module loader tries to *fetch*, failing with
 * "Failed to fetch dynamically imported module: node:http". A `require()` call
 * of an external module is preserved as-is and resolved by Electron's Node
 * integration, which is what we want.
 *
 * It stays lazy (rather than a top-level import) so that loading the plugin on
 * a platform without Node still succeeds, and only connecting reports the
 * problem. `scripts/check-bundle.mjs` guards the `import()` regression.
 */
function loadNodeHttp(): typeof import("node:http") {
  if (typeof require !== "function") {
    throw new Error(
      "Node APIs are unavailable here, so the sign-in listener cannot start. " +
        "Connecting requires Obsidian on desktop.",
    );
  }
  // Deliberate: an ESM import here is emitted as a dynamic import() that
  // Electron's renderer cannot resolve. scripts/check-bundle.mjs enforces this.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("node:http") as typeof import("node:http");
}

const OK_PAGE = (heading: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>YouVersion Sync</title>` +
  `<style>body{font-family:system-ui,sans-serif;max-width:34rem;margin:15vh auto;padding:0 1.5rem;` +
  `line-height:1.55;color:#1c1c1e}h1{font-size:1.25rem}p{color:#555}</style>` +
  `<h1>${heading}</h1><p>${body}</p>`;

/**
 * Bind the loopback listener. Resolve the returned `result` promise before
 * exchanging the code; the caller owns closing the handle in a `finally`.
 */
export async function startLoopbackReceiver(options: LoopbackOptions): Promise<LoopbackHandle> {
  const http = loadNodeHttp();

  let settle: ((r: LoopbackResult) => void) | null = null;
  let fail: ((e: Error) => void) | null = null;
  const result = new Promise<LoopbackResult>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  let server: Server | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
      // `close()` waits for keep-alive sockets; Node 18.2+ can force them shut.
      server.closeAllConnections?.();
    });
  };

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://127.0.0.1:${options.port}`);
    } catch {
      res.writeHead(400).end();
      return;
    }

    if (url.pathname !== options.path) {
      res.writeHead(404).end();
      return;
    }

    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");

    // Validate state on every hop before acting on anything else (CSRF).
    if (!state || state !== options.expectedState) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        OK_PAGE(
          "Sign-in could not be verified",
          "State mismatch. Close this tab and try connecting again from Obsidian.",
        ),
      );
      fail?.(new Error("OAuth state mismatch — possible CSRF. Authorization aborted."));
      return;
    }

    if (error) {
      const description = url.searchParams.get("error_description") ?? "";
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        OK_PAGE(
          "Authorization was not completed",
          "You can close this tab and return to Obsidian.",
        ),
      );
      fail?.(new Error(redactError(`Authorization failed: ${error} ${description}`.trim())));
      return;
    }

    if (!code) {
      // First hop: state-only. Replay `state` alone via a top-level navigation.
      const replay = new URL(options.replayEndpoint);
      replay.searchParams.set("state", state);
      res.writeHead(302, { Location: replay.toString() });
      res.end();
      return;
    }

    // Second hop: the authorization code is here.
    const granted = (url.searchParams.get("granted_permissions") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(OK_PAGE("Connected to YouVersion", "You can close this tab and return to Obsidian."));
    settle?.({ code, state, grantedPermissions: granted });
  };

  server = http.createServer(handler);

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      reject(
        err.code === "EADDRINUSE"
          ? new Error(
              `Port ${options.port} is already in use. Change the callback port in settings ` +
                `and update the redirect URI registered in the YouVersion Platform Portal.`,
            )
          : new Error(redactError(err)),
      );
    };
    server?.once("error", onError);
    // Bind to loopback only — never expose this listener on the network.
    server?.listen(options.port, "127.0.0.1", () => {
      server?.off("error", onError);
      resolve();
    });
  });

  timer = setTimeout(() => {
    fail?.(new Error("Timed out waiting for the YouVersion sign-in to complete."));
  }, options.timeoutMs);

  // The caller always awaits `result`; make sure an early rejection is observed.
  void result.catch(() => undefined);

  return { result, close };
}
