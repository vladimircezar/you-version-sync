import { beforeEach, describe, expect, it } from "vitest";
import { MemoryVault } from "./mocks/memoryVault";
import {
  collectHighlightEntries,
  readField,
  rebuildAllIndexes,
  renderDashboard,
  renderHighlightIndex,
} from "../src/markdown/indexes";
import { SyncEngine } from "../src/sync/engine";
import { HighlightItem, emptySyncState } from "../src/models/domain";
import { ChapterTask, HighlightSource } from "../src/providers/types";

const ROOT = "Sources/YouVersion";

function highlight(usfm: string, color = "44aa44"): HighlightItem {
  return {
    id: `3034:${usfm}`,
    type: "highlight",
    usfm,
    reference: usfm,
    bibleId: 3034,
    bibleVersion: "BSB",
    color,
    canonicalUrl: `https://www.bible.com/bible/3034/${usfm}`,
  };
}

class Source implements HighlightSource {
  constructor(private readonly items: Record<string, HighlightItem[]>) {}
  async planScan() {
    return {
      chapters: Object.keys(this.items).map((c) => ({ chapterUsfm: c, bibleId: 3034 })),
      fingerprint: "fp",
    };
  }
  async fetchChapterHighlights(task: ChapterTask) {
    return this.items[task.chapterUsfm] ?? [];
  }
}

const DASH_CTX = {
  connected: true,
  accountDisplayName: "Test User",
  providerName: "YouVersion official API",
  lastSuccessfulSyncAt: "2026-08-30T12:00:00.000Z",
  lastSummary: null,
  destinationRoot: ROOT,
  bibleId: 3034,
  bibleVersion: "BSB",
};

let vault: MemoryVault;

beforeEach(async () => {
  vault = new MemoryVault();
  const engine = new SyncEngine({
    io: vault,
    source: new Source({ "JHN.3": [highlight("JHN.3.16"), highlight("JHN.3.17")] }),
    destinationRoot: ROOT,
    conflictPolicy: "preserve",
    removalPolicy: "mark",
    saveState: async () => undefined,
  });
  await engine.run(emptySyncState());
});

describe("field reading", () => {
  it("reads bare and quoted scalars", () => {
    expect(readField("a: bare", "a")).toBe("bare");
    expect(readField('b: "quoted value"', "b")).toBe("quoted value");
    expect(readField('c: "with \\"escape\\""', "c")).toBe('with "escape"');
    expect(readField("d:", "d")).toBeUndefined();
    expect(readField("a: 1", "missing")).toBeUndefined();
  });
});

describe("collecting entries from the vault", () => {
  it("reads every synced note without contacting the API", async () => {
    const entries = await collectHighlightEntries(vault, ROOT);
    expect(entries.map((e) => e.id).sort()).toEqual(["3034:JHN.3.16", "3034:JHN.3.17"]);
    expect(entries[0]?.reference).toBeTruthy();
    expect(entries[0]?.bibleVersion).toBe("BSB");
  });

  it("ignores notes that are not ours", async () => {
    vault.files.set(`${ROOT}/Highlights/mine.md`, "---\nsource: me\n---\n\nhello\n");
    const entries = await collectHighlightEntries(vault, ROOT);
    expect(entries).toHaveLength(2);
  });

  it("ignores conflict sidecars", async () => {
    vault.files.set(
      `${ROOT}/Highlights/3034-JHN.3.18.sync-conflict.md`,
      '---\nsource: youversion\nyouversion_id: "3034:JHN.3.18"\nusfm: JHN.3.18\n---\n\nx\n',
    );
    const entries = await collectHighlightEntries(vault, ROOT);
    expect(entries).toHaveLength(2);
  });

  it("skips a note with no frontmatter", async () => {
    vault.files.set(`${ROOT}/Highlights/bare.md`, "no frontmatter here");
    await expect(collectHighlightEntries(vault, ROOT)).resolves.toHaveLength(2);
  });
});

describe("index rendering", () => {
  it("renders a table linking each note by path", async () => {
    const entries = await collectHighlightEntries(vault, ROOT);
    const md = renderHighlightIndex(entries);
    expect(md).toContain("| Reference | Version | Color | Status | Note |");
    expect(md).toContain(`[[${ROOT}/Highlights/3034-JHN.3.16|`);
    expect(md).toContain("2 highlights imported.");
  });

  it("handles an empty vault", () => {
    const md = renderHighlightIndex([]);
    expect(md).toContain("No highlights have been imported yet.");
  });

  it("marks itself as generated", () => {
    expect(renderHighlightIndex([])).toContain("rewritten on every sync");
  });
});

describe("dashboard", () => {
  it("states which categories the API does not expose", async () => {
    const entries = await collectHighlightEntries(vault, ROOT);
    const md = renderDashboard(entries, DASH_CTX);
    expect(md).toContain("Notes");
    expect(md).toContain("Bookmarks and saved verses");
    expect(md).toContain("Reading plans and progress");
    expect(md).toContain("Not supported");
    expect(md).toContain("Last successful sync");
    expect(md).toContain("Test User");
  });

  it("lists conflicts and missing items when present", () => {
    const md = renderDashboard(
      [
        {
          path: "a.md",
          id: "1",
          reference: "John 3:16",
          usfm: "JHN.3.16",
          color: "",
          bibleVersion: "",
          url: "",
          status: "conflict",
          lastSyncedAt: "",
        },
        {
          path: "b.md",
          id: "2",
          reference: "John 3:17",
          usfm: "JHN.3.17",
          color: "",
          bibleVersion: "",
          url: "",
          status: "missing_remote",
          lastSyncedAt: "",
        },
      ],
      DASH_CTX,
    );
    expect(md).toContain("## Conflicts");
    expect(md).toContain("## No longer in YouVersion");
  });
});

describe("rebuilding indexes", () => {
  it("rebuilds every generated file from the vault alone", async () => {
    const result = await rebuildAllIndexes(vault, ROOT, DASH_CTX);
    expect(result.highlights).toBe(2);
    expect(vault.files.has(`${ROOT}/Dashboard.md`)).toBe(true);
    expect(vault.files.has(`${ROOT}/Indexes/Highlights.md`)).toBe(true);
    expect(vault.files.has(`${ROOT}/Indexes/Notes.md`)).toBe(true);
    expect(vault.files.has(`${ROOT}/Indexes/Bookmarks.md`)).toBe(true);
    expect(vault.files.has(`${ROOT}/Indexes/Plans.md`)).toBe(true);
  });

  it("explains why the unavailable indexes are empty", async () => {
    await rebuildAllIndexes(vault, ROOT, DASH_CTX);
    expect(vault.files.get(`${ROOT}/Indexes/Plans.md`)).toContain("Not available");
    expect(vault.files.get(`${ROOT}/Indexes/Notes.md`)).toContain("not a supported permission");
  });

  it("is deterministic - rebuilding twice produces identical files", async () => {
    await rebuildAllIndexes(vault, ROOT, DASH_CTX);
    const first = vault.files.get(`${ROOT}/Indexes/Highlights.md`);
    await rebuildAllIndexes(vault, ROOT, DASH_CTX);
    expect(vault.files.get(`${ROOT}/Indexes/Highlights.md`)).toBe(first);
  });

  it("does not include index notes in the highlight count", async () => {
    await rebuildAllIndexes(vault, ROOT, DASH_CTX);
    const second = await rebuildAllIndexes(vault, ROOT, DASH_CTX);
    expect(second.highlights).toBe(2);
  });
});
