/**
 * Static assertions about the built bundle.
 *
 * Unit tests run against source; they cannot see what esbuild actually emitted.
 * This closes that gap. It exists because a real bug shipped through it: a
 * lazy `await import("node:http")` type-checked, passed every test, and was
 * emitted verbatim into the CommonJS bundle - where Obsidian's Electron
 * renderer treated it as an ESM module to *fetch*, so "Connect account" failed
 * with "Failed to fetch dynamically imported module: node:http". Node builtins
 * must be reached with `require()`, and that is now enforced rather than
 * eyeballed.
 */
import { readFileSync, existsSync } from "node:fs";
import process from "node:process";

const BUNDLE = "main.js";

/** Hosts the plugin is allowed to reference. Anything else is a policy breach. */
const ALLOWED_HOSTS = ["api.youversion.com", "www.bible.com"];

/** Modules the bundle may pull in at runtime. */
const ALLOWED_REQUIRES = ["obsidian", "node:http"];

const failures = [];
const notes = [];

function fail(message) {
  failures.push(message);
}

if (!existsSync(BUNDLE)) {
  console.error(`check-bundle: ${BUNDLE} not found. Run the build first.`);
  process.exit(1);
}

const bundle = readFileSync(BUNDLE, "utf8");

// 1. Node builtins must be required, never dynamically imported.
const dynamicNodeImports = bundle.match(/import\(\s*["'`]node:[^"'`]+["'`]\s*\)/g) ?? [];
if (dynamicNodeImports.length > 0) {
  fail(
    `dynamic import() of a Node builtin: ${[...new Set(dynamicNodeImports)].join(", ")}\n` +
      `      Electron's renderer cannot fetch these. Use require() instead.`,
  );
}

// 2. No dynamic import() of anything at all in a CJS bundle.
const anyDynamicImport = bundle.match(/(?:^|[^.\w])import\(\s*["'`][^"'`]+["'`]\s*\)/g) ?? [];
if (anyDynamicImport.length > 0) {
  fail(`dynamic import() survives in a CJS bundle: ${[...new Set(anyDynamicImport)].join(", ")}`);
}

// 3. Only expected modules are required at runtime.
const requires = [...new Set((bundle.match(/require\(\s*["']([^"']+)["']\s*\)/g) ?? []))].map((m) =>
  m.replace(/require\(\s*["']|["']\s*\)/g, ""),
);
for (const mod of requires) {
  if (!ALLOWED_REQUIRES.includes(mod)) fail(`unexpected require(): ${mod}`);
}
notes.push(`requires: ${requires.join(", ") || "(none)"}`);

// 4. Only expected hosts are referenced.
const hosts = [...new Set((bundle.match(/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}/gi) ?? []))].map((u) =>
  u.replace(/^https?:\/\//, ""),
);
for (const host of hosts) {
  if (!ALLOWED_HOSTS.includes(host)) fail(`unexpected network host in bundle: ${host}`);
}
notes.push(`hosts: ${hosts.join(", ") || "(none)"}`);

// 5. No credentials baked into the bundle.
if (/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/.test(bundle)) fail("a JWT appears in the bundle");
if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(bundle)) fail("a private key appears in the bundle");

// 6. The plugin must stay read-only against YouVersion: the OAuth token exchange
//    is the only POST, and there must be no write calls to the highlights API.
if (/["'`]\/v1\/highlights["'`]\s*,\s*["'`]?(POST|DELETE)/i.test(bundle)) {
  fail("a write call to the highlights API appears in the bundle");
}

notes.push(`size: ${(bundle.length / 1024).toFixed(1)} KB`);

for (const note of notes) console.log(`  ${note}`);

if (failures.length > 0) {
  console.error(`\ncheck-bundle: ${failures.length} problem(s) found:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log("  check-bundle: OK");
