// Bundles scripts/preview.mts (aliasing the `obsidian` module to the test stub,
// since the preview runs outside Obsidian) and executes it with Node.
import esbuild from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const out = path.join(mkdtempSync(path.join(tmpdir(), "yvs-preview-")), "preview.mjs");

await esbuild.build({
  entryPoints: ["scripts/preview.mts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: out,
  alias: { obsidian: path.resolve("tests/mocks/obsidian.ts") },
  logLevel: "warning",
});

const result = spawnSync(process.execPath, [out, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(result.status ?? 1);
