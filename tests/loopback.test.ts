/**
 * End-to-end tests for the OAuth loopback receiver, over real HTTP.
 *
 * These start the actual listener on a real port and drive it with real
 * requests, because this is the one component that cannot be reasoned about
 * from its types: it depends on `node:http` resolving, on the redirect being a
 * genuine 302 the browser will follow, and on the three-hop sequence matching
 * what YouVersion's docs describe.
 *
 * The absence of these tests is why a broken `node:http` load shipped.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { startLoopbackReceiver, type LoopbackHandle } from "../src/auth/loopback";

const REPLAY = "https://api.youversion.com/auth/callback";
const STATE = "test-state-value";

/** Ask the OS for a port that is currently free. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

let open: LoopbackHandle[] = [];

async function start(port: number, expectedState = STATE, timeoutMs = 5000) {
  const handle = await startLoopbackReceiver({
    port,
    path: "/callback",
    replayEndpoint: REPLAY,
    expectedState,
    timeoutMs,
  });
  open.push(handle);
  return handle;
}

/** Never follow redirects: hop 1's `Location` is the thing under test. */
function hit(port: number, query: string) {
  return fetch(`http://127.0.0.1:${port}/callback${query}`, { redirect: "manual" });
}

afterEach(async () => {
  await Promise.all(open.map((h) => h.close()));
  open = [];
});

describe("node:http loading", () => {
  it("resolves node:http and binds a real listener", async () => {
    const port = await freePort();
    const handle = await start(port);
    // Reaching here at all proves the module loaded; a 404 proves it is serving.
    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(res.status).toBe(404);
    await handle.close();
  });
});

describe("the three-hop flow", () => {
  it("redirects the state-only first callback to /auth/callback", async () => {
    const port = await freePort();
    await start(port);

    const res = await hit(port, `?state=${STATE}`);

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith(REPLAY)).toBe(true);
    expect(new URL(location).searchParams.get("state")).toBe(STATE);
    // The replay must carry state and nothing else.
    expect([...new URL(location).searchParams.keys()]).toEqual(["state"]);
  });

  it("resolves with the authorization code on the second callback", async () => {
    const port = await freePort();
    const handle = await start(port);

    const res = await hit(port, `?code=AUTH_CODE&state=${STATE}&granted_permissions=highlights`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Connected to YouVersion");

    await expect(handle.result).resolves.toEqual({
      code: "AUTH_CODE",
      state: STATE,
      grantedPermissions: ["highlights"],
    });
  });

  it("completes the full sequence in order", async () => {
    const port = await freePort();
    const handle = await start(port);

    const first = await hit(port, `?state=${STATE}`);
    expect(first.status).toBe(302);

    // The browser would follow to YouVersion and come back with a code.
    const second = await hit(port, `?code=CODE2&state=${STATE}`);
    expect(second.status).toBe(200);

    const result = await handle.result;
    expect(result.code).toBe("CODE2");
    expect(result.grantedPermissions).toEqual([]);
  });

  it("parses multiple granted permissions", async () => {
    const port = await freePort();
    const handle = await start(port);
    await hit(port, `?code=C&state=${STATE}&granted_permissions=highlights,%20other`);
    await expect(handle.result).resolves.toMatchObject({
      grantedPermissions: ["highlights", "other"],
    });
  });
});

describe("rejections", () => {
  it("rejects a state mismatch without processing anything else", async () => {
    const port = await freePort();
    const handle = await start(port);

    const res = await hit(port, `?code=SHOULD_BE_IGNORED&state=wrong-state`);
    expect(res.status).toBe(400);

    await expect(handle.result).rejects.toThrow(/state mismatch/i);
  });

  it("rejects a missing state", async () => {
    const port = await freePort();
    const handle = await start(port);
    const res = await hit(port, "");
    expect(res.status).toBe(400);
    await expect(handle.result).rejects.toThrow(/state mismatch/i);
  });

  it("surfaces a denied authorization instead of looping on the replay", async () => {
    const port = await freePort();
    const handle = await start(port);

    const res = await hit(
      port,
      `?state=${STATE}&error=access_denied&error_description=User%20said%20no`,
    );
    expect(res.status).toBe(200);
    await expect(handle.result).rejects.toThrow(/access_denied/);
  });

  it("times out rather than hanging forever", async () => {
    const port = await freePort();
    const handle = await start(port, STATE, 60);
    await expect(handle.result).rejects.toThrow(/Timed out/);
  });

  it("reports a port clash with actionable advice", async () => {
    const port = await freePort();
    await start(port);
    await expect(start(port)).rejects.toThrow(/already in use/);
  });

  it("ignores paths other than the callback path", async () => {
    const port = await freePort();
    await start(port);
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/callback/extra`)).status).toBe(404);
  });
});

describe("lifecycle", () => {
  it("stops listening after close, and close is idempotent", async () => {
    const port = await freePort();
    const handle = await start(port);

    await handle.close();
    await handle.close();

    await expect(fetch(`http://127.0.0.1:${port}/callback?state=${STATE}`)).rejects.toThrow();
  });

  it("binds only to loopback, not to a routable interface", async () => {
    // Note: connecting to 0.0.0.0 is NOT a valid check - the OS routes it to
    // localhost, so it reaches a loopback-bound listener. Use a real LAN address.
    const lan = Object.values(networkInterfaces())
      .flat()
      .find((i) => i && i.family === "IPv4" && !i.internal)?.address;

    const port = await freePort();
    await start(port);

    if (!lan) {
      // No routable interface on this machine; assert the binding directly instead.
      expect((await hit(port, `?state=${STATE}`)).status).toBe(302);
      return;
    }

    await expect(
      fetch(`http://${lan}:${port}/callback?state=${STATE}`, { redirect: "manual" }),
    ).rejects.toThrow();
  });
});
