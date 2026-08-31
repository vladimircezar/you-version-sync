/**
 * Static chapter counts for the 66-book Protestant canon.
 *
 * The scan normally enumerates chapters from `GET /v1/bibles/{id}/index`, which
 * is the right source: it reflects the actual version, including
 * deuterocanonical books and any versification quirks.
 *
 * But that endpoint can be refused for a Bible your App Key is not licensed
 * for, and highlights are stored per version - so a user whose highlights live
 * in, say, ESV could be blocked from syncing them purely because the *text* of
 * that version is not licensed to their app, even though the highlights
 * endpoint itself returns no scripture and may answer perfectly well.
 *
 * This table is the fallback for exactly that case. It is deliberately the
 * plain 66-book canon: it will miss deuterocanonical books, and any version
 * with unusual chapter counts, which is why it is only used when the index is
 * unavailable and why the sync reports when it fell back.
 */

export const CANON_CHAPTER_COUNTS: Readonly<Record<string, number>> = {
  // Old Testament
  GEN: 50,
  EXO: 40,
  LEV: 27,
  NUM: 36,
  DEU: 34,
  JOS: 24,
  JDG: 21,
  RUT: 4,
  "1SA": 31,
  "2SA": 24,
  "1KI": 22,
  "2KI": 25,
  "1CH": 29,
  "2CH": 36,
  EZR: 10,
  NEH: 13,
  EST: 10,
  JOB: 42,
  PSA: 150,
  PRO: 31,
  ECC: 12,
  SNG: 8,
  ISA: 66,
  JER: 52,
  LAM: 5,
  EZK: 48,
  DAN: 12,
  HOS: 14,
  JOL: 3,
  AMO: 9,
  OBA: 1,
  JON: 4,
  MIC: 7,
  NAM: 3,
  HAB: 3,
  ZEP: 3,
  HAG: 2,
  ZEC: 14,
  MAL: 4,
  // New Testament
  MAT: 28,
  MRK: 16,
  LUK: 24,
  JHN: 21,
  ACT: 28,
  ROM: 16,
  "1CO": 16,
  "2CO": 13,
  GAL: 6,
  EPH: 6,
  PHP: 4,
  COL: 4,
  "1TH": 5,
  "2TH": 3,
  "1TI": 6,
  "2TI": 4,
  TIT: 3,
  PHM: 1,
  HEB: 13,
  JAS: 5,
  "1PE": 5,
  "2PE": 3,
  "1JN": 5,
  "2JN": 1,
  "3JN": 1,
  JUD: 1,
  REV: 22,
};

/** Canonical book order, Genesis to Revelation. */
export const CANON_BOOK_ORDER: readonly string[] = Object.keys(CANON_CHAPTER_COUNTS);

export const NEW_TESTAMENT_BOOKS: ReadonlySet<string> = new Set([
  "MAT",
  "MRK",
  "LUK",
  "JHN",
  "ACT",
  "ROM",
  "1CO",
  "2CO",
  "GAL",
  "EPH",
  "PHP",
  "COL",
  "1TH",
  "2TH",
  "1TI",
  "2TI",
  "TIT",
  "PHM",
  "HEB",
  "JAS",
  "1PE",
  "2PE",
  "1JN",
  "2JN",
  "3JN",
  "JUD",
  "REV",
]);

/**
 * Every chapter USFM in the canon, in order: `GEN.1` … `REV.22`.
 * Used only when the Bible index cannot be fetched.
 */
export function canonChapters(): string[] {
  const chapters: string[] = [];
  for (const book of CANON_BOOK_ORDER) {
    const count = CANON_CHAPTER_COUNTS[book] ?? 0;
    for (let chapter = 1; chapter <= count; chapter++) chapters.push(`${book}.${chapter}`);
  }
  return chapters;
}

/** Total chapters in the canon. A well-known 1,189 - useful as a sanity check. */
export function canonChapterCount(): number {
  return Object.values(CANON_CHAPTER_COUNTS).reduce((sum, n) => sum + n, 0);
}
