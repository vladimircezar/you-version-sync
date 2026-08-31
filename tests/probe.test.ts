/**
 * The probe's diagnosis logic. `interpret` is pure, so every branch of
 * "why did the sync find nothing?" is testable without a network or account.
 */
import { describe, expect, it } from "vitest";
import {
  InvalidReferenceError,
  formatProbeReport,
  interpret,
  probeHighlightAccess,
} from "../src/diagnostics/probe";
import type { OfficialApiProvider } from "../src/providers/officialApi";

const none = { status: 204, count: 0 };
const hit = { status: 200, count: 1 };

describe("diagnosis", () => {
  it("identifies an expired or rejected token", () => {
    const r = interpret({
      verseLevel: { status: 401, count: 0 },
      chapterLevel: null,
      otherVersions: [],
      configuredBibleId: 3034,
    });
    expect(r.conclusion).toContain("401");
    expect(r.remedy).toContain("Reconnect");
  });

  it("identifies a missing permission", () => {
    const r = interpret({
      verseLevel: { status: 403, count: 0 },
      chapterLevel: null,
      otherVersions: [],
      configuredBibleId: 3034,
    });
    expect(r.conclusion).toContain("403");
    expect(r.remedy).toContain("Platform Portal");
  });

  it("identifies the wrong Bible version, and names the right one", () => {
    const r = interpret({
      verseLevel: none,
      chapterLevel: none,
      otherVersions: [{ bibleId: 111, abbreviation: "NIV", status: 200, count: 1 }],
      configuredBibleId: 3034,
    });
    expect(r.conclusion).toContain("stored per Bible version");
    expect(r.conclusion).toContain("NIV (111)");
    expect(r.remedy).toContain("111");
  });

  it("identifies chapter queries not working - the design-breaking case", () => {
    const r = interpret({
      verseLevel: hit,
      chapterLevel: none,
      otherVersions: [],
      configuredBibleId: 3034,
    });
    expect(r.conclusion).toContain("chapter-level query");
    expect(r.conclusion).toContain("contrary to the documentation");
    expect(r.remedy).toContain("verse-level queries");
  });

  it("reports a healthy setup with no remedy", () => {
    const r = interpret({
      verseLevel: hit,
      chapterLevel: hit,
      otherVersions: [],
      configuredBibleId: 3034,
    });
    expect(r.conclusion).toContain("both working correctly");
    expect(r.remedy).toBeNull();
  });

  it("handles a chapter with highlights but not on the asked verse", () => {
    const r = interpret({
      verseLevel: none,
      chapterLevel: { status: 200, count: 3 },
      otherVersions: [],
      configuredBibleId: 3034,
    });
    expect(r.conclusion).toContain("not on the verse asked about");
    expect(r.remedy).toBeNull();
  });

  it("falls through to 'nothing anywhere' with actionable advice", () => {
    const r = interpret({
      verseLevel: none,
      chapterLevel: none,
      otherVersions: [],
      configuredBibleId: 3034,
    });
    expect(r.conclusion).toContain("none of the other versions");
    expect(r.remedy).toContain("same account");
  });
});

/** A provider stub that records what was asked and answers from a table. */
function stubProvider(
  answers: Record<string, { status: number; count: number }>,
  bibles: Array<{ id: number; abbreviation: string }> = [],
) {
  const asked: string[] = [];
  const provider = {
    async probeHighlights(bibleId: number, passageId: string) {
      const key = `${bibleId}:${passageId}`;
      asked.push(key);
      return answers[key] ?? { status: 204, count: 0 };
    },
    async listBibles() {
      return bibles;
    },
  } as unknown as OfficialApiProvider;
  return { provider, asked };
}

describe("probe orchestration", () => {
  it("queries verse level and chapter level in the configured version", async () => {
    const { provider, asked } = stubProvider({ "3034:JHN.3.16": hit, "3034:JHN.3": hit });
    const report = await probeHighlightAccess(provider, "JHN.3.16", 3034);

    expect(asked).toEqual(["3034:JHN.3.16", "3034:JHN.3"]);
    expect(report.reference).toBe("John 3:16");
    expect(report.chapterUsfm).toBe("JHN.3");
    expect(report.remedy).toBeNull();
  });

  it("sweeps other versions only when the configured one is empty", async () => {
    const { provider, asked } = stubProvider({ "3034:JHN.3.16": hit, "3034:JHN.3": hit }, [
      { id: 111, abbreviation: "NIV" },
    ]);
    await probeHighlightAccess(provider, "JHN.3.16", 3034);
    expect(asked.some((a) => a.startsWith("111:"))).toBe(false);
  });

  it("finds the version the highlight actually lives in", async () => {
    const { provider } = stubProvider({ "111:JHN.3.16": hit }, [
      { id: 111, abbreviation: "NIV" },
      { id: 59, abbreviation: "ESV" },
    ]);
    const report = await probeHighlightAccess(provider, "JHN.3.16", 3034);
    expect(report.otherVersions.map((v) => v.bibleId)).toEqual([111]);
    expect(report.remedy).toContain("111");
  });

  it("normalizes a lowercase reference", async () => {
    const { provider, asked } = stubProvider({});
    await probeHighlightAccess(provider, "jhn.3.16", 3034);
    expect(asked[0]).toBe("3034:JHN.3.16");
  });

  it("rejects anything that is not a verse reference", async () => {
    const { provider } = stubProvider({});
    await expect(probeHighlightAccess(provider, "JHN.3", 3034)).rejects.toBeInstanceOf(
      InvalidReferenceError,
    );
    await expect(probeHighlightAccess(provider, "nonsense", 3034)).rejects.toBeInstanceOf(
      InvalidReferenceError,
    );
  });
});

describe("report formatting", () => {
  it("renders a copy-pasteable summary", async () => {
    const { provider } = stubProvider({
      "3034:JHN.3.16": hit,
      "3034:JHN.3": { status: 204, count: 0 },
    });
    const text = formatProbeReport(await probeHighlightAccess(provider, "JHN.3.16", 3034));
    expect(text).toContain("Verse tested:      John 3:16 (JHN.3.16)");
    expect(text).toContain("Verse-level query");
    expect(text).toContain("Chapter-level query");
    expect(text).toContain("Conclusion:");
    expect(text).toContain("What to do:");
  });
});

describe("bounded execution", () => {
  /** A provider whose version sweep never finds anything, to force a full sweep. */
  function slowSweep(versionCount: number, msPerCall: number) {
    let clock = 0;
    const bibles = Array.from({ length: versionCount }, (_, i) => ({
      id: 1000 + i,
      abbreviation: `V${i}`,
    }));
    const provider = {
      async probeHighlights() {
        clock += msPerCall;
        return { status: 204, count: 0 };
      },
      async listBibles() {
        return bibles;
      },
    } as unknown as OfficialApiProvider;
    return { provider, now: () => clock, calls: () => clock / msPerCall };
  }

  it("stops sweeping at the deadline instead of running unbounded", async () => {
    const { provider, now, calls } = slowSweep(30, 5000);
    const report = await probeHighlightAccess(provider, "MAT.8.23", 3034, {
      now,
      deadlineMs: 20_000,
    });
    // 2 configured-version calls, then only as many versions as fit the deadline.
    expect(calls()).toBeLessThan(10);
    expect(report.conclusion).toContain("cut short");
    expect(report.remedy).toContain("Load versions");
  });

  it("stops at the first version that has the highlight", async () => {
    const asked: number[] = [];
    const provider = {
      async probeHighlights(bibleId: number) {
        asked.push(bibleId);
        return bibleId === 111 ? { status: 200, count: 1 } : { status: 204, count: 0 };
      },
      async listBibles() {
        return [
          { id: 100, abbreviation: "A" },
          { id: 111, abbreviation: "NIV" },
          { id: 200, abbreviation: "B" },
        ];
      },
    } as unknown as OfficialApiProvider;

    const report = await probeHighlightAccess(provider, "MAT.8.23", 3034);
    expect(asked).not.toContain(200);
    expect(report.remedy).toContain("111");
  });

  it("honours an abort signal", async () => {
    const controller = new AbortController();
    const provider = {
      async probeHighlights() {
        controller.abort();
        return { status: 204, count: 0 };
      },
      async listBibles() {
        return [
          { id: 1, abbreviation: "A" },
          { id: 2, abbreviation: "B" },
        ];
      },
    } as unknown as OfficialApiProvider;

    const report = await probeHighlightAccess(provider, "MAT.8.23", 3034, {
      ctx: { signal: controller.signal },
    });
    expect(report.conclusion).toContain("cut short");
  });

  it("reports progress so the UI can show life", async () => {
    const events: string[] = [];
    const provider = {
      async probeHighlights() {
        return { status: 204, count: 0 };
      },
      async listBibles() {
        return [{ id: 111, abbreviation: "NIV" }];
      },
    } as unknown as OfficialApiProvider;

    await probeHighlightAccess(provider, "MAT.8.23", 3034, {
      onProgress: (_d, _t, label) => events.push(label),
    });
    expect(events[0]).toContain("MAT.8.23");
    expect(events.some((e) => e.includes("chapter MAT.8"))).toBe(true);
    expect(events.some((e) => e.includes("NIV"))).toBe(true);
  });
});

describe("canon fallback", () => {
  it("covers the whole 66-book canon", async () => {
    const { canonChapterCount, canonChapters } = await import("../src/markdown/canon");
    // The well-known total; a wrong table would show up here immediately.
    expect(canonChapterCount()).toBe(1189);
    const chapters = canonChapters();
    expect(chapters).toHaveLength(1189);
    expect(chapters[0]).toBe("GEN.1");
    expect(chapters[chapters.length - 1]).toBe("REV.22");
    expect(chapters).toContain("MAT.8");
    expect(chapters).toContain("PSA.150");
  });

  it("has no duplicate chapters", async () => {
    const { canonChapters } = await import("../src/markdown/canon");
    const chapters = canonChapters();
    expect(new Set(chapters).size).toBe(chapters.length);
  });
});
