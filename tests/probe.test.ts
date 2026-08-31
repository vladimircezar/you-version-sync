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
