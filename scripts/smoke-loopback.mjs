/**
 * Smoke test for the OAuth loopback receiver as it is actually shipped.
 *
 * The unit tests in tests/loopback.test.ts import TypeScript source. The bug
 * that broke "Connect account" lived in the *emitted* bundle: esbuild turned a
 * lazy `await import("node:http")` into a native dynamic import that Electron's
 * renderer tried to fetch over the network. Source-level tests cannot see that.
 *
 * So this bundles loopback.ts with the exact production settings (CommonJS,
 * Node builtins external), requires the output, and drives the real three-hop
 * flow over real HTTP against it.
 *
 *   npm run smoke
 */
import esbuild from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import builtins from "builtin-modules";

const out = path.join(mkdtempSync(path.join(tmpdir(), "yvs-loop-")), "loopback.cjs");

await esbuild.build({
  entryPoints: ["src/auth/loopback.ts"],
  bundle: true, format: "cjs", target: "es2022", outfile: out, minify: true,
  external: ["obsidian", "electron", ...builtins, ...builtins.map((m) => `node:${m}`)],
  logLevel: "warning",
});

const mod = createRequire(import.meta.url)(out);
const PORT = 51799, STATE = "s-123";

const handle = await mod.startLoopbackReceiver({
  port: PORT, path: "/callback",
  replayEndpoint: "https://api.youversion.com/auth/callback",
  expectedState: STATE, timeoutMs: 4000,
});
console.log("  [1] bundled module loaded node:http and bound a listener  OK");

const hop1 = await fetch(`http://127.0.0.1:${PORT}/callback?state=${STATE}`, { redirect: "manual" });
console.log(`  [2] hop 1 -> ${hop1.status} ${hop1.headers.get("location")}`);
if (hop1.status !== 302) { console.error("  FAIL: expected 302"); process.exit(1); }

const hop2 = await fetch(`http://127.0.0.1:${PORT}/callback?code=CODE&state=${STATE}&granted_permissions=highlights`, { redirect: "manual" });
console.log(`  [3] hop 2 -> ${hop2.status}`);

const result = await handle.result;
console.log(`  [4] resolved: code=${result.code} permissions=${JSON.stringify(result.grantedPermissions)}`);
await handle.close();

const ok = result.code === "CODE" && result.grantedPermissions[0] === "highlights";
console.log(ok ? "\n  BUNDLED ARTIFACT WORKS" : "\n  FAIL");
process.exit(ok ? 0 : 1);
