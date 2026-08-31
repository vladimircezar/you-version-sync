/**
 * "Why did my sync find nothing?" - answered with evidence rather than guesses.
 *
 * A sync returning zero highlights has two very different likely causes, and
 * they need opposite fixes:
 *
 *   1. **The wrong Bible version.** Highlights are stored per version, and
 *      `GET /v1/highlights` requires you to name one. Highlights made in NIV
 *      are invisible to a query against BSB. This is easy to hit, because the
 *      version is configured as a bare numeric id.
 *
 *   2. **Chapter-level queries not behaving as documented.** The scan asks
 *      whole chapters at a time (`JHN.3`) because the docs say a chapter
 *      `passage_id` is accepted and returns one row per highlighted verse. That
 *      was never verified against a live account. If only verse-level queries
 *      work, the whole scan strategy is wrong.
 *
 * This probe distinguishes them: it asks one verse the user knows is
 * highlighted, at verse level and chapter level, in the configured version and
 * in every other version the App Key can see.
 */
import { OfficialApiProvider } from "../providers/officialApi";
import { ProviderContext } from "../providers/types";
import { chapterUsfmOf, formatReference, parseUsfm } from "../markdown/reference";

export interface ProbeOutcome {
  status: number;
  count: number;
  note?: string;
}

export interface VersionProbe extends ProbeOutcome {
  bibleId: number;
  abbreviation: string;
}

export interface ProbeReport {
  verseUsfm: string;
  chapterUsfm: string | null;
  reference: string;
  configuredBibleId: number;
  verseLevel: ProbeOutcome;
  chapterLevel: ProbeOutcome | null;
  otherVersions: VersionProbe[];
  conclusion: string;
  /** Suggested action, or `null` when everything looks correct. */
  remedy: string | null;
}

/** How many versions to sweep. Each is one request; keep it civil. */
const MAX_VERSIONS = 30;

export class InvalidReferenceError extends Error {
  constructor(input: string) {
    super(
      `"${input}" is not a verse reference this plugin understands. ` +
        `Use USFM, for example JHN.3.16 or PSA.23.1.`,
    );
    this.name = "InvalidReferenceError";
  }
}

/**
 * Probe one verse the user believes is highlighted.
 *
 * `verseUsfm` must be verse-level: a chapter cannot answer "is the version
 * wrong?" unambiguously, since a chapter query is itself one of the suspects.
 */
export async function probeHighlightAccess(
  provider: OfficialApiProvider,
  verseUsfm: string,
  configuredBibleId: number,
  ctx: ProviderContext = {},
): Promise<ProbeReport> {
  const parsed = parseUsfm(verseUsfm);
  if (!parsed || parsed.chapter === null || parsed.verse === null) {
    throw new InvalidReferenceError(verseUsfm);
  }

  const normalized = `${parsed.book}.${parsed.chapter}.${parsed.verse}`;
  const chapterUsfm = chapterUsfmOf(normalized);

  const verseLevel = await provider.probeHighlights(configuredBibleId, normalized, ctx);
  const chapterLevel = chapterUsfm
    ? await provider.probeHighlights(configuredBibleId, chapterUsfm, ctx)
    : null;

  // Only sweep other versions when the configured one came back empty; if it
  // already has the highlight, the version is not the problem.
  const otherVersions: VersionProbe[] = [];
  if (verseLevel.count === 0 && (chapterLevel?.count ?? 0) === 0) {
    let bibles: Array<{ id: number; abbreviation: string }> = [];
    try {
      bibles = await provider.listBibles(ctx);
    } catch {
      bibles = [];
    }
    for (const bible of bibles.filter((b) => b.id !== configuredBibleId).slice(0, MAX_VERSIONS)) {
      if (ctx.signal?.aborted) break;
      const outcome = await provider.probeHighlights(bible.id, normalized, ctx);
      if (outcome.count > 0 || outcome.status === 403) {
        otherVersions.push({ ...outcome, bibleId: bible.id, abbreviation: bible.abbreviation });
      }
    }
  }

  const { conclusion, remedy } = interpret({
    verseLevel,
    chapterLevel,
    otherVersions,
    configuredBibleId,
  });

  return {
    verseUsfm: normalized,
    chapterUsfm,
    reference: formatReference(normalized),
    configuredBibleId,
    verseLevel,
    chapterLevel,
    otherVersions,
    conclusion,
    remedy,
  };
}

/** Turn raw probe outcomes into a diagnosis. Pure, so it is directly testable. */
export function interpret(input: {
  verseLevel: ProbeOutcome;
  chapterLevel: ProbeOutcome | null;
  otherVersions: VersionProbe[];
  configuredBibleId: number;
}): { conclusion: string; remedy: string | null } {
  const { verseLevel, chapterLevel, otherVersions, configuredBibleId } = input;

  if (verseLevel.status === 401) {
    return {
      conclusion: "The API rejected the access token (401).",
      remedy: "Reconnect your account.",
    };
  }

  if (verseLevel.status === 403) {
    return {
      conclusion: "The API refused the request (403) - the highlights permission is not in effect.",
      remedy:
        "Check that your app requests the highlights permission in the Platform Portal, then " +
        "disconnect and reconnect, approving it.",
    };
  }

  const found = otherVersions.filter((v) => v.count > 0);
  if (verseLevel.count === 0 && found.length > 0) {
    const names = found.map((v) => `${v.abbreviation} (${v.bibleId})`).join(", ");
    return {
      conclusion:
        `This verse is not highlighted in version ${configuredBibleId}, but it IS highlighted ` +
        `in: ${names}. Highlights are stored per Bible version.`,
      remedy: `Set "Preferred Bible version" to ${found[0]?.bibleId} and sync again.`,
    };
  }

  if (verseLevel.count > 0 && chapterLevel !== null && chapterLevel.count === 0) {
    return {
      conclusion:
        "The verse-level query found the highlight, but the chapter-level query for the same " +
        "chapter found nothing. A chapter passage_id does not return per-verse highlights on " +
        "this account, contrary to the documentation.",
      remedy:
        "The chapter scan cannot work. Report this output - the plugin needs to fall back to " +
        "verse-level queries, which is a much heavier scan and a design change.",
    };
  }

  if (verseLevel.count > 0 && (chapterLevel?.count ?? 0) > 0) {
    return {
      conclusion:
        "Both verse-level and chapter-level queries found the highlight. The API and the scan " +
        "strategy are both working correctly for this version.",
      remedy: null,
    };
  }

  if (verseLevel.count === 0 && (chapterLevel?.count ?? 0) > 0) {
    return {
      conclusion:
        "The chapter-level query found highlights in this chapter, but not on the verse asked " +
        "about. The scan works; that particular verse is not highlighted in this version.",
      remedy: null,
    };
  }

  return {
    conclusion:
      `No highlight found on this verse in version ${configuredBibleId}, and none of the other ` +
      "versions available to your App Key had it either.",
    remedy:
      "Check the verse really is highlighted in the YouVersion app, and that you signed in as " +
      "the same account. If your reading version is not in the list your App Key can see, its " +
      "highlights cannot be reached - add that Bible to your app in the Platform Portal.",
  };
}

/** Render a report as plain text, safe to paste into an issue. */
export function formatProbeReport(report: ProbeReport): string {
  const describe = (o: ProbeOutcome | null): string =>
    o === null ? "not run" : `HTTP ${o.status}, ${o.count} row(s)${o.note ? ` - ${o.note}` : ""}`;

  const lines = [
    `YouVersion Sync - highlight access probe`,
    ``,
    `Verse tested:      ${report.reference} (${report.verseUsfm})`,
    `Bible version:     ${report.configuredBibleId}`,
    ``,
    `Verse-level query (${report.verseUsfm}):   ${describe(report.verseLevel)}`,
    `Chapter-level query (${report.chapterUsfm ?? "n/a"}): ${describe(report.chapterLevel)}`,
    ``,
  ];

  if (report.otherVersions.length > 0) {
    lines.push(`Other versions that responded:`);
    for (const v of report.otherVersions) {
      lines.push(`  ${v.abbreviation} (${v.bibleId}): ${describe(v)}`);
    }
    lines.push("");
  }

  lines.push(`Conclusion: ${report.conclusion}`);
  if (report.remedy) lines.push(`What to do: ${report.remedy}`);
  return lines.join("\n");
}
