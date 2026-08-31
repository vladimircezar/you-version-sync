/**
 * Sync engine behaviour. Every test runs against an in-memory vault and a
 * scripted highlight source, so nothing here needs a network or an account.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { SyncEngine } from "../src/sync/engine";
import { MemoryVault } from "./mocks/memoryVault";
import { HighlightItem, SyncState, emptySyncState } from "../src/models/domain";
import { ChapterTask, HighlightSource, ProviderContext } from "../src/providers/types";
import { readManagedRegion, readUserRegion } from "../src/markdown/managedSection";
import { readField } from "../src/markdown/indexes";
import { splitDocument } from "../src/markdown/frontmatter";
import { CancelledError } from "../src/sync/rateLimit";

const ROOT = "Sources/YouVersion";
const PATH_316 = `${ROOT}/Highlights/3034-JHN.3.16.md`;
const PATH_317 = `${ROOT}/Highlights/3034-JHN.3.17.md`;

function highlight(usfm: string, color = "44aa44"): HighlightItem {
  return {
    id: `3034:${usfm}`,
    type: "highlight",
    usfm,
    reference: usfm.replace("JHN.", "John ").replace(/\.(\d+)$/, ":$1"),
    bibleId: 3034,
    bibleVersion: "BSB",
    color,
    canonicalUrl: `https://www.bible.com/bible/3034/${usfm}`,
  };
}

/** A source scripted with a chapter list and per-chapter results. */
class ScriptedSource implements HighlightSource {
  calls: string[] = [];
  failOn = new Set<string>();
  throwCancelOn: string | null = null;

  constructor(
    public chapters: string[],
    public byChapter: Record<string, HighlightItem[]>,
    public fingerprint = "fp-1",
  ) {}

  async planScan(): Promise<{ chapters: ChapterTask[]; fingerprint: string }> {
    return {
      chapters: this.chapters.map((c) => ({ chapterUsfm: c, bibleId: 3034 })),
      fingerprint: this.fingerprint,
    };
  }

  async fetchChapterHighlights(task: ChapterTask, _ctx: ProviderContext): Promise<HighlightItem[]> {
    this.calls.push(task.chapterUsfm);
    if (this.throwCancelOn === task.chapterUsfm) throw new CancelledError();
    if (this.failOn.has(task.chapterUsfm)) throw new Error("chapter blew up");
    return this.byChapter[task.chapterUsfm] ?? [];
  }
}

function makeEngine(
  vault: MemoryVault,
  source: HighlightSource,
  overrides: Partial<{
    conflictPolicy: "preserve" | "overwrite" | "skip";
    removalPolicy: "mark" | "archive" | "ignore";
    organization: "verse" | "chapter";
  }> = {},
) {
  const saved: SyncState[] = [];
  const engine = new SyncEngine({
    io: vault,
    source,
    destinationRoot: ROOT,
    conflictPolicy: overrides.conflictPolicy ?? "preserve",
    removalPolicy: overrides.removalPolicy ?? "mark",
    organization: overrides.organization ?? "verse",
    saveState: async (s) => {
      saved.push(JSON.parse(JSON.stringify(s)) as SyncState);
    },
  });
  return { engine, saved };
}

let vault: MemoryVault;
let state: SyncState;

beforeEach(() => {
  vault = new MemoryVault();
  state = emptySyncState();
});

describe("creating notes", () => {
  it("writes a note per highlight with the documented structure", async () => {
    const source = new ScriptedSource(["JHN.3"], { "JHN.3": [highlight("JHN.3.16")] });
    const { engine } = makeEngine(vault, source);
    const summary = await engine.run(state);

    expect(summary.created).toBe(1);
    const note = vault.files.get(PATH_316);
    expect(note).toBeDefined();

    const { frontmatter } = splitDocument(note as string);
    expect(readField(frontmatter as string, "source")).toBe("youversion");
    expect(readField(frontmatter as string, "youversion_id")).toBe("3034:JHN.3.16");
    expect(readField(frontmatter as string, "usfm")).toBe("JHN.3.16");
    expect(readField(frontmatter as string, "sync_status")).toBe("synced");
    expect(readManagedRegion(note as string)).toContain("Open in YouVersion");
    expect(readUserRegion(note as string)).toContain("My notes");
  });

  it("omits metadata the API does not provide", async () => {
    const source = new ScriptedSource(["JHN.3"], { "JHN.3": [highlight("JHN.3.16")] });
    const { engine } = makeEngine(vault, source);
    await engine.run(state);
    const note = vault.files.get(PATH_316) as string;
    expect(note).not.toContain("created_at");
    expect(note).not.toContain("updated_at");
  });

  it("handles many highlights across many chapters", async () => {
    const chapters = ["JHN.1", "JHN.2", "JHN.3"];
    const source = new ScriptedSource(chapters, {
      "JHN.1": [highlight("JHN.1.1")],
      "JHN.2": [],
      "JHN.3": [highlight("JHN.3.16"), highlight("JHN.3.17")],
    });
    const { engine } = makeEngine(vault, source);
    const summary = await engine.run(state);

    expect(summary.created).toBe(3);
    expect(summary.chaptersScanned).toBe(3);
    expect(vault.files.size).toBe(3);
  });
});

describe("incremental behaviour", () => {
  it("does not rewrite an unchanged note on a second run", async () => {
    const source = new ScriptedSource(["JHN.3"], { "JHN.3": [highlight("JHN.3.16")] });
    const { engine } = makeEngine(vault, source);

    await engine.run(state);
    const afterFirst = vault.files.get(PATH_316);
    const writesAfterFirst = vault.writeLog.length;

    const second = await engine.run(state);
    expect(second.unchanged).toBe(1);
    expect(second.created).toBe(0);
    expect(second.updated).toBe(0);
    expect(vault.writeLog.length).toBe(writesAfterFirst);
    expect(vault.files.get(PATH_316)).toBe(afterFirst);
  });

  it("updates a note when the color changes", async () => {
    const source = new ScriptedSource(["JHN.3"], { "JHN.3": [highlight("JHN.3.16", "44aa44")] });
    const { engine } = makeEngine(vault, source);
    await engine.run(state);

    source.byChapter["JHN.3"] = [highlight("JHN.3.16", "ff0000")];
    const second = await engine.run(state);

    expect(second.updated).toBe(1);
    expect(vault.files.get(PATH_316)).toContain("#ff0000");
    expect(vault.files.get(PATH_316)).not.toContain("#44aa44");
  });

  it("preserves imported_at across updates", async () => {
    const source = new ScriptedSource(["JHN.3"], { "JHN.3": [highlight("JHN.3.16", "44aa44")] });
    const { engine } = makeEngine(vault, source);
    await engine.run(state);
    const first = readField(
      splitDocument(vault.files.get(PATH_316) as string).frontmatter as string,
      "imported_at",
    );

    source.byChapter["JHN.3"] = [highlight("JHN.3.16", "ff0000")];
    await engine.run(state);
    const second = readField(
      splitDocument(vault.files.get(PATH_316) as string).frontmatter as string,
      "imported_at",
    );

    expect(second).toBe(first);
  });
});

describe("idempotence and duplicate prevention", () => {
  it("produces exactly one note no matter how many times it runs", async () => {
    const source = new ScriptedSource(["JHN.3"], { "JHN.3": [highlight("JHN.3.16")] });
    const { engine } = makeEngine(vault, source);
    await engine.run(state);
    await engine.run(state);
    await engine.run(state);
    expect([...vault.files.keys()]).toEqual([PATH_316]);
  });

  it("does not duplicate after a crash that lost the sync state", async () => {
    const source = new ScriptedSource(["JHN.3"], { "JHN.3": [highlight("JHN.3.16")] });
    const { engine } = makeEngine(vault, source);
    await engine.run(state);

    // Simulate losing data.json but keeping the vault.
    const freshState = emptySyncState();
    const second = await engine.run(freshState);

    expect([...vault.files.keys()]).toEqual([PATH_316]);
    // The note is rewritten (state was lost), but no second file appears.
    expect(second.created + second.updated).toBe(1);
  });
});

describe("user content preservation", () => {
  it("never touches the user region when updating", async () => {
    const source = new ScriptedSource(["JHN.3"], { "JHN.3": [highlight("JHN.3.16", "44aa44")] });
    const { engine } = makeEngine(vault, source);
    await engine.run(state);

    const withNotes = (vault.files.get(PATH_316) as string).replace(
      "## My notes",
      "## My notes\n\nThis verse mattered to me on a hard day.",
    );
    vault.files.set(PATH_316, withNotes);

    source.byChapter["JHN.3"] = [highlight("JHN.3.16", "ff0000")];
    await engine.run(state);

    expect(vault.files.get(PATH_316)).toContain("This verse mattered to me on a hard day.");
    expect(vault.files.get(PATH_316)).toContain("#ff0000");
  });

  it("preserves frontmatter keys the user added", async () => {
    const source = new ScriptedSource(["JHN.3"], { "JHN.3": [highlight("JHN.3.16", "44aa44")] });
    const { engine } = makeEngine(vault, source);
    await engine.run(state);

    vault.files.set(
      PATH_316,
      (vault.files.get(PATH_316) as string).replace(
        "source: youversion",
        "source: youversion\nmy_rating: 5",
      ),
    );

    source.byChapter["JHN.3"] = [highlight("JHN.3.16", "ff0000")];
    await engine.run(state);
    expect(vault.files.get(PATH_316)).toContain("my_rating: 5");
  });
});

describe("conflict detection", () => {
  it("flags an edit inside the managed region and leaves the note alone", async () => {
    const source = new ScriptedSource(["JHN.3"], { "JHN.3": [highlight("JHN.3.16", "44aa44")] });
    const { engine } = makeEngine(vault, source);
    await engine.run(state);

    const tampered = (vault.files.get(PATH_316) as string).replace(
      "Open in YouVersion",
      "Open in YouVersion (I edited this line)",
    );
    vault.files.set(PATH_316, tampered);

    source.byChapter["JHN.3"] = [highlight("JHN.3.16", "ff0000")];
    const second = await engine.run(state);

    expect(second.conflicted).toBe(1);
    expect(vault.files.get(PATH_316)).toBe(tampered);
    expect(vault.files.has(`${ROOT}/Highlights/3034-JHN.3.16.sync-conflict.md`)).toBe(true);
  });

  it("overwrites the managed region when the policy says so", async () => {
    const source = new ScriptedSource(["JHN.3"], { "JHN.3": [highlight("JHN.3.16", "44aa44")] });
    const { engine } = makeEngine(vault, source, { conflictPolicy: "overwrite" });
    await engine.run(state);

    vault.files.set(
      PATH_316,
      (vault.files.get(PATH_316) as string).replace("Open in YouVersion", "I edited this"),
    );
    source.byChapter["JHN.3"] = [highlight("JHN.3.16", "ff0000")];
    const second = await engine.run(state);

    expect(second.updated).toBe(1);
    expect(vault.files.get(PATH_316)).toContain("Open in YouVersion");
  });

  it("treats a note with no markers as a conflict rather than rewriting it", async () => {
    const source = new ScriptedSource(["JHN.3"], { "JHN.3": [highlight("JHN.3.16")] });
    const { engine } = makeEngine(vault, source);
    const handwritten = "---\nsource: youversion\n---\n\n# My own note about John 3:16\n";
    vault.files.set(PATH_316, handwritten);

    const summary = await engine.run(state);

    expect(summary.conflicted).toBe(1);
    expect(vault.files.get(PATH_316)).toBe(handwritten);
  });
});

describe("removed remote items", () => {
  it("marks a note missing_remote once it disappears", async () => {
    const source = new ScriptedSource(["JHN.3"], {
      "JHN.3": [highlight("JHN.3.16"), highlight("JHN.3.17")],
    });
    const { engine } = makeEngine(vault, source);
    await engine.run(state);

    source.byChapter["JHN.3"] = [highlight("JHN.3.16")];
    const second = await engine.run(state);

    expect(second.archived).toBe(1);
    expect(vault.files.get(PATH_317)).toContain("sync_status: missing_remote");
    expect(vault.files.has(PATH_317)).toBe(true);
  });

  it("archives instead of deleting when the policy says so", async () => {
    const source = new ScriptedSource(["JHN.3"], {
      "JHN.3": [highlight("JHN.3.16"), highlight("JHN.3.17")],
    });
    const { engine } = makeEngine(vault, source, { removalPolicy: "archive" });
    await engine.run(state);

    source.byChapter["JHN.3"] = [highlight("JHN.3.16")];
    await engine.run(state);

    expect(vault.files.has(PATH_317)).toBe(false);
    expect(vault.files.has(`${ROOT}/Archive/3034-JHN.3.17.md`)).toBe(true);
  });

  it("leaves notes untouched under the ignore policy", async () => {
    const source = new ScriptedSource(["JHN.3"], {
      "JHN.3": [highlight("JHN.3.16"), highlight("JHN.3.17")],
    });
    const { engine } = makeEngine(vault, source, { removalPolicy: "ignore" });
    await engine.run(state);
    const before = vault.files.get(PATH_317);

    source.byChapter["JHN.3"] = [highlight("JHN.3.16")];
    await engine.run(state);
    expect(vault.files.get(PATH_317)).toBe(before);
  });

  it("never deletes a note", async () => {
    const source = new ScriptedSource(["JHN.3"], { "JHN.3": [highlight("JHN.3.16")] });
    const { engine } = makeEngine(vault, source);
    await engine.run(state);

    source.byChapter["JHN.3"] = [];
    await engine.run(state);
    expect(vault.files.has(PATH_316)).toBe(true);
  });

  it("does not treat a chapter outside the scanned scope as removed", async () => {
    const wide = new ScriptedSource(["JHN.3", "GEN.1"], {
      "JHN.3": [highlight("JHN.3.16")],
      "GEN.1": [highlight("GEN.1.1")],
    });
    const { engine: wideEngine } = makeEngine(vault, wide);
    await wideEngine.run(state);

    // Narrow the scope to John only; Genesis is now simply not looked at.
    const narrow = new ScriptedSource(["JHN.3"], { "JHN.3": [highlight("JHN.3.16")] }, "fp-2");
    const { engine: narrowEngine } = makeEngine(vault, narrow);
    const summary = await narrowEngine.run(state);

    expect(summary.archived).toBe(0);
    expect(vault.files.get(`${ROOT}/Highlights/3034-GEN.1.1.md`)).not.toContain("missing_remote");
  });
});

describe("interruption and resumption", () => {
  it("persists a cursor after each chapter", async () => {
    const source = new ScriptedSource(["JHN.1", "JHN.2", "JHN.3"], {});
    const { engine, saved } = makeEngine(vault, source);
    await engine.run(state);
    const cursors = saved.map((s) => s.cursor?.nextChapterIndex).filter((n) => n !== undefined);
    expect(cursors).toEqual([1, 2, 3]);
  });

  it("resumes from the cursor rather than restarting", async () => {
    const chapters = ["JHN.1", "JHN.2", "JHN.3"];
    const source = new ScriptedSource(chapters, { "JHN.3": [highlight("JHN.3.16")] });
    const { engine } = makeEngine(vault, source);

    // Pretend a previous run stopped after two chapters.
    state.cursor = {
      bibleId: 3034,
      nextChapterIndex: 2,
      scopeFingerprint: "fp-1",
      startedAt: "2026-01-01T00:00:00Z",
    };

    const summary = await engine.run(state);
    expect(source.calls).toEqual(["JHN.3"]);
    expect(summary.chaptersScanned).toBe(1);
    expect(summary.created).toBe(1);
  });

  it("discards a cursor whose scope no longer matches", async () => {
    const source = new ScriptedSource(["JHN.1", "JHN.2"], {}, "fp-new");
    const { engine } = makeEngine(vault, source);
    state.cursor = {
      bibleId: 3034,
      nextChapterIndex: 1,
      scopeFingerprint: "fp-old",
      startedAt: "x",
    };

    await engine.run(state);
    expect(source.calls).toEqual(["JHN.1", "JHN.2"]);
  });

  it("clears the cursor after a complete pass", async () => {
    const source = new ScriptedSource(["JHN.1"], {});
    const { engine } = makeEngine(vault, source);
    await engine.run(state);
    expect(state.cursor).toBeNull();
    expect(state.lastSuccessfulSyncAt).not.toBeNull();
  });

  it("stops cleanly when cancelled and keeps the cursor for next time", async () => {
    const source = new ScriptedSource(["JHN.1", "JHN.2", "JHN.3"], {});
    source.throwCancelOn = "JHN.2";
    const { engine } = makeEngine(vault, source);

    const summary = await engine.run(state);
    expect(summary.cancelled).toBe(true);
    expect(state.cursor?.nextChapterIndex).toBe(1);
    expect(state.lastSuccessfulSyncAt).toBeNull();
  });

  it("honours an abort signal mid-scan", async () => {
    const controller = new AbortController();
    const chapters = ["JHN.1", "JHN.2", "JHN.3"];
    const source = new ScriptedSource(chapters, {});
    const originalFetch = source.fetchChapterHighlights.bind(source);
    source.fetchChapterHighlights = async (task, ctx) => {
      if (task.chapterUsfm === "JHN.2") controller.abort();
      return originalFetch(task, ctx);
    };

    const { engine } = makeEngine(vault, source);
    const summary = await engine.run(state, controller.signal);
    expect(summary.cancelled).toBe(true);
    expect(summary.chaptersScanned).toBeLessThan(3);
  });

  it("does not skip a chapter that failed - the cursor advances only after reconciliation", async () => {
    const source = new ScriptedSource(["JHN.1", "JHN.2"], { "JHN.2": [highlight("JHN.2.1")] });
    source.failOn.add("JHN.1");
    const { engine } = makeEngine(vault, source);

    const summary = await engine.run(state);
    expect(summary.failed).toBe(1);
    expect(summary.errors[0]).toContain("JHN.1");
    // The rest of the scan still completes.
    expect(summary.created).toBe(1);
  });
});

describe("failure handling", () => {
  it("counts a write failure without aborting the run", async () => {
    const source = new ScriptedSource(["JHN.3"], {
      "JHN.3": [highlight("JHN.3.16"), highlight("JHN.3.17")],
    });
    vault.failWritesTo = PATH_316;
    const { engine } = makeEngine(vault, source);

    const summary = await engine.run(state);
    expect(summary.failed).toBe(1);
    expect(summary.created).toBe(1);
    expect(vault.files.has(PATH_317)).toBe(true);
  });

  it("reports a planning failure as an error rather than throwing", async () => {
    const broken: HighlightSource = {
      planScan: async () => {
        throw new Error("index unavailable");
      },
      fetchChapterHighlights: async () => [],
    };
    const { engine } = makeEngine(vault, broken);
    const summary = await engine.run(state);
    expect(summary.failed).toBe(1);
    expect(summary.errors[0]).toContain("Could not plan the scan");
  });
});

describe("summary", () => {
  it("reports every outcome category", async () => {
    const source = new ScriptedSource(["JHN.3"], { "JHN.3": [highlight("JHN.3.16")] });
    const { engine } = makeEngine(vault, source);
    const summary = await engine.run(state);

    expect(Object.keys(summary)).toEqual(
      expect.arrayContaining([
        "created",
        "updated",
        "unchanged",
        "archived",
        "conflicted",
        "failed",
        "chaptersScanned",
        "chaptersTotal",
        "startedAt",
        "finishedAt",
        "cancelled",
        "errors",
      ]),
    );
    expect(summary.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(summary.finishedAt).toMatch(/Z$/);
  });
});

describe("chapter organization", () => {
  it("collects a chapter's highlights into one note", async () => {
    const source = new ScriptedSource(["JHN.3"], {
      "JHN.3": [highlight("JHN.3.17"), highlight("JHN.3.16", "ffdd00")],
    });
    const { engine } = makeEngine(vault, source, { organization: "chapter" });
    const summary = await engine.run(state);

    expect(summary.created).toBe(1);
    expect([...vault.files.keys()]).toEqual([`${ROOT}/Highlights/3034-JHN.3.md`]);

    const note = vault.files.get(`${ROOT}/Highlights/3034-JHN.3.md`) as string;
    const { frontmatter } = splitDocument(note);
    expect(readField(frontmatter as string, "youversion_type")).toBe("highlight-chapter");
    expect(readField(frontmatter as string, "youversion_id")).toBe("3034:JHN.3");
    expect(readField(frontmatter as string, "usfm")).toBe("JHN.3");
    expect(readField(frontmatter as string, "highlight_count")).toBe("2");
    // No single color applies to a chapter, so the field is omitted.
    expect(readField(frontmatter as string, "color")).toBeUndefined();
  });

  it("orders verses canonically regardless of API order", async () => {
    const source = new ScriptedSource(["JHN.3"], {
      "JHN.3": [highlight("JHN.3.17"), highlight("JHN.3.2"), highlight("JHN.3.16")],
    });
    const { engine } = makeEngine(vault, source, { organization: "chapter" });
    await engine.run(state);

    const body = readManagedRegion(
      vault.files.get(`${ROOT}/Highlights/3034-JHN.3.md`) as string,
    ) as string;
    expect(body.indexOf("JHN.3.2")).toBeLessThan(body.indexOf("JHN.3.16"));
    expect(body.indexOf("JHN.3.16")).toBeLessThan(body.indexOf("JHN.3.17"));
  });

  it("is incremental: an unchanged chapter is not rewritten", async () => {
    const source = new ScriptedSource(["JHN.3"], {
      "JHN.3": [highlight("JHN.3.16"), highlight("JHN.3.17")],
    });
    const { engine } = makeEngine(vault, source, { organization: "chapter" });
    await engine.run(state);
    const writes = vault.writeLog.length;

    const second = await engine.run(state);
    expect(second.unchanged).toBe(1);
    expect(vault.writeLog.length).toBe(writes);
  });

  it("updates the chapter note when any verse in it changes", async () => {
    const source = new ScriptedSource(["JHN.3"], {
      "JHN.3": [highlight("JHN.3.16", "44aa44"), highlight("JHN.3.17")],
    });
    const { engine } = makeEngine(vault, source, { organization: "chapter" });
    await engine.run(state);

    source.byChapter["JHN.3"] = [highlight("JHN.3.16", "ff0000"), highlight("JHN.3.17")];
    const second = await engine.run(state);
    expect(second.updated).toBe(1);
    expect(vault.files.get(`${ROOT}/Highlights/3034-JHN.3.md`)).toContain("#ff0000");
  });

  it("preserves the user region in chapter mode too", async () => {
    const source = new ScriptedSource(["JHN.3"], { "JHN.3": [highlight("JHN.3.16", "44aa44")] });
    const { engine } = makeEngine(vault, source, { organization: "chapter" });
    await engine.run(state);

    const path = `${ROOT}/Highlights/3034-JHN.3.md`;
    vault.files.set(
      path,
      (vault.files.get(path) as string).replace("## My notes", "## My notes\n\nmine"),
    );

    source.byChapter["JHN.3"] = [highlight("JHN.3.16", "ff0000")];
    await engine.run(state);
    expect(vault.files.get(path)).toContain("mine");
  });

  it("marks a chapter note missing_remote when its last highlight goes", async () => {
    const source = new ScriptedSource(["JHN.3"], { "JHN.3": [highlight("JHN.3.16")] });
    const { engine } = makeEngine(vault, source, { organization: "chapter" });
    await engine.run(state);

    source.byChapter["JHN.3"] = [];
    const second = await engine.run(state);
    expect(second.archived).toBe(1);
    expect(vault.files.get(`${ROOT}/Highlights/3034-JHN.3.md`)).toContain(
      "sync_status: missing_remote",
    );
  });

  it("does not collide with per-verse ids", async () => {
    const verseSource = new ScriptedSource(["JHN.3"], { "JHN.3": [highlight("JHN.3.16")] });
    const { engine: verseEngine } = makeEngine(vault, verseSource);
    await verseEngine.run(state);

    const chapterSource = new ScriptedSource(["JHN.3"], { "JHN.3": [highlight("JHN.3.16")] });
    const { engine: chapterEngine } = makeEngine(vault, chapterSource, { organization: "chapter" });
    await chapterEngine.run(emptySyncState());

    expect(vault.files.has(`${ROOT}/Highlights/3034-JHN.3.16.md`)).toBe(true);
    expect(vault.files.has(`${ROOT}/Highlights/3034-JHN.3.md`)).toBe(true);
  });
});

describe("atomic writes (Vault.process semantics)", () => {
  /**
   * A vault where an edit lands *after* the engine has read a note but before
   * it writes - the exact race Vault.process() exists to survive.
   */
  class RacingVault extends MemoryVault {
    constructor(private readonly onRead: (path: string) => void) {
      super();
    }
    override async read(path: string): Promise<string> {
      const value = await super.read(path);
      this.onRead(path);
      return value;
    }
  }

  it("carries through an edit made between the read and the write", async () => {
    const path = PATH_316;
    let raced = false;
    const racing = new RacingVault((p) => {
      // Simulate the user typing into the note just after we read it.
      if (p !== path || raced) return;
      raced = true;
      racing.files.set(
        path,
        (racing.files.get(path) as string).replace("## My notes", "## My notes\n\nlate edit"),
      );
    });

    const source = new ScriptedSource(["JHN.3"], { "JHN.3": [highlight("JHN.3.16", "44aa44")] });
    const { engine } = makeEngine(racing, source);
    await engine.run(state);

    // Second run updates the note, and races with an edit while doing so.
    source.byChapter["JHN.3"] = [highlight("JHN.3.16", "ff0000")];
    const summary = await engine.run(state);

    expect(summary.updated).toBe(1);
    const final = racing.files.get(path) as string;
    expect(final).toContain("late edit"); // the racing edit survived
    expect(final).toContain("#ff0000"); // and the sync still applied
  });

  it("aborts the write rather than corrupting a note whose markers vanished mid-run", async () => {
    const path = PATH_316;
    let raced = false;
    const racing = new RacingVault((p) => {
      if (p !== path || !racing.files.get(path)?.includes("managed:start") || raced) return;
      raced = true;
      racing.files.set(path, "# the user replaced this note entirely\n");
    });

    const source = new ScriptedSource(["JHN.3"], { "JHN.3": [highlight("JHN.3.16", "44aa44")] });
    const { engine } = makeEngine(racing, source);
    await engine.run(state);

    source.byChapter["JHN.3"] = [highlight("JHN.3.16", "ff0000")];
    const summary = await engine.run(state);

    expect(summary.conflicted).toBe(1);
    expect(racing.files.get(path)).toBe("# the user replaced this note entirely\n");
  });

  it("trashes rather than hard-deletes when archiving", async () => {
    const source = new ScriptedSource(["JHN.3"], {
      "JHN.3": [highlight("JHN.3.16"), highlight("JHN.3.17")],
    });
    const { engine } = makeEngine(vault, source, { removalPolicy: "archive" });
    await engine.run(state);

    source.byChapter["JHN.3"] = [highlight("JHN.3.16")];
    await engine.run(state);

    expect(vault.trashed).toEqual([PATH_317]);
    expect(vault.files.has(`${ROOT}/Archive/3034-JHN.3.17.md`)).toBe(true);
  });

  it("creates a new note through create(), not a blind overwrite", async () => {
    const source = new ScriptedSource(["JHN.3"], { "JHN.3": [highlight("JHN.3.16")] });
    const created: string[] = [];
    const spy = new MemoryVault();
    const originalCreate = spy.create.bind(spy);
    spy.create = async (p, c) => {
      created.push(p);
      return originalCreate(p, c);
    };

    const { engine } = makeEngine(spy, source);
    await engine.run(state);
    expect(created).toEqual([PATH_316]);
  });
});
