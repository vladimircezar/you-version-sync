/**
 * Offline preview: run the real sync engine against fixture highlights and
 * write the result into a real folder.
 *
 * This exercises the actual production code paths - the same SyncEngine,
 * note renderer, frontmatter merger and index builder the plugin uses - with a
 * scripted provider in place of the network. It needs no App Key, no account
 * and no connection, so you can see exactly what the plugin produces before
 * committing to the OAuth setup.
 *
 *   npm run preview -- /path/to/vault
 *
 * Run it twice to watch incremental sync report everything as unchanged, and
 * edit a note's "My notes" section in between to prove it is preserved.
 */
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { SyncEngine } from "../src/sync/engine";
import { rebuildAllIndexes } from "../src/markdown/indexes";
import { emptySyncState, type HighlightItem, type SyncState } from "../src/models/domain";
import type { ChapterTask, HighlightSource } from "../src/providers/types";
import type { VaultIO } from "../src/markdown/vaultIo";
import { bibleComUrl } from "../src/constants";
import { formatReference } from "../src/markdown/reference";

/** A VaultIO over the real filesystem, standing in for Obsidian's adapter. */
class FsVault implements VaultIO {
  constructor(private readonly root: string) {}

  private abs(p: string): string {
    return path.join(this.root, p);
  }

  async exists(p: string): Promise<boolean> {
    return existsSync(this.abs(p));
  }

  async read(p: string): Promise<string> {
    return readFile(this.abs(p), "utf8");
  }

  async create(p: string, content: string): Promise<void> {
    await this.write(p, content);
  }

  /** Mirrors Vault.process: transform the current contents atomically. */
  async process(p: string, fn: (data: string) => string): Promise<void> {
    const current = await this.read(p);
    await this.write(p, fn(current));
  }

  async write(p: string, content: string): Promise<void> {
    await mkdir(path.dirname(this.abs(p)), { recursive: true });
    await writeFile(this.abs(p), content, "utf8");
  }

  async listFiles(folder: string): Promise<string[]> {
    const dir = this.abs(folder);
    if (!existsSync(dir)) return [];
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => `${folder}/${e.name}`);
  }

  async trash(p: string): Promise<void> {
    await rm(this.abs(p), { force: true });
  }
}

const BIBLE_ID = 3034;
const VERSION = "BSB";

/** Fixture highlights. Invented sample data - not from anyone's account. */
const SAMPLE: Array<[usfm: string, color: string, text?: string]> = [
  ["JHN.1.1", "44aa44", "In the beginning was the Word, and the Word was with God."],
  ["JHN.3.16", "ffdd00", "For God so loved the world that He gave His one and only Son."],
  ["JHN.3.17", "ffdd00"],
  ["ROM.8.28", "66ccff", "And we know that God works all things together for the good of those who love Him."],
  ["PSA.23.1", "ff8866", "The LORD is my shepherd; I shall not want."],
];

function toItem([usfm, color, text]: (typeof SAMPLE)[number]): HighlightItem {
  return {
    id: `${BIBLE_ID}:${usfm}`,
    type: "highlight",
    usfm,
    reference: formatReference(usfm),
    bibleId: BIBLE_ID,
    bibleVersion: VERSION,
    color,
    canonicalUrl: bibleComUrl(BIBLE_ID, usfm),
    verseText: text,
    copyright: text
      ? "Berean Standard Bible (BSB). This text has been dedicated to the public domain."
      : undefined,
  };
}

/** Groups the fixtures by chapter, exactly as the real provider would. */
function buildSource(): HighlightSource {
  const byChapter = new Map<string, HighlightItem[]>();
  for (const row of SAMPLE) {
    const item = toItem(row);
    const chapter = item.usfm.split(".").slice(0, 2).join(".");
    byChapter.set(chapter, [...(byChapter.get(chapter) ?? []), item]);
  }
  const chapters = [...byChapter.keys()];

  return {
    async planScan() {
      return {
        chapters: chapters.map((c) => ({ chapterUsfm: c, bibleId: BIBLE_ID })),
        fingerprint: `preview-${chapters.length}`,
      };
    },
    async fetchChapterHighlights(task: ChapterTask) {
      return byChapter.get(task.chapterUsfm) ?? [];
    },
  };
}

async function main(): Promise<void> {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: npm run preview -- /path/to/vault");
    process.exit(1);
  }
  if (!existsSync(target)) {
    console.error(`No such folder: ${target}`);
    process.exit(1);
  }

  const root = "Sources/YouVersion";
  const io = new FsVault(target);
  const statePath = path.join(target, ".youversion-preview-state.json");

  // Reuse previous state so a second run demonstrates incremental behaviour.
  let state: SyncState = emptySyncState();
  if (existsSync(statePath)) {
    state = JSON.parse(await readFile(statePath, "utf8")) as SyncState;
  }

  const engine = new SyncEngine({
    io,
    source: buildSource(),
    destinationRoot: root,
    conflictPolicy: "preserve",
    removalPolicy: "mark",
    organization: "verse",
    saveState: async (s) => {
      await writeFile(statePath, JSON.stringify(s, null, 2), "utf8");
    },
  });

  const summary = await engine.run(state);

  await rebuildAllIndexes(io, root, {
    connected: false,
    accountDisplayName: "",
    providerName: "Offline preview (fixture data, no API call)",
    lastSuccessfulSyncAt: state.lastSuccessfulSyncAt,
    lastSummary: summary,
    destinationRoot: root,
    bibleId: BIBLE_ID,
    bibleVersion: VERSION,
  });

  console.log(`\nPreview written to ${path.join(target, root)}\n`);
  console.log(
    `  created=${summary.created}  updated=${summary.updated}  unchanged=${summary.unchanged}  ` +
      `conflicted=${summary.conflicted}  failed=${summary.failed}`,
  );
  console.log(`  chapters scanned: ${summary.chaptersScanned}/${summary.chaptersTotal}`);
  if (summary.errors.length > 0) console.log(`  errors: ${summary.errors.join("; ")}`);
  console.log("\nRun it again to see every item reported as unchanged.");
}

await main();
