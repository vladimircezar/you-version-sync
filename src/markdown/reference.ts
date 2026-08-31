/**
 * USFM to human-readable reference.
 *
 * The highlights API returns only a USFM passage id (`JHN.3.16`). Book titles
 * come from the Bible index for the version in use, so references match the
 * user's translation and language; the table below is a fallback for when the
 * index has not been fetched (offline index rebuilds, for instance).
 */

/** Standard USFM 3-character book identifiers, English names. */
export const USFM_BOOK_NAMES: Readonly<Record<string, string>> = {
  GEN: "Genesis",
  EXO: "Exodus",
  LEV: "Leviticus",
  NUM: "Numbers",
  DEU: "Deuteronomy",
  JOS: "Joshua",
  JDG: "Judges",
  RUT: "Ruth",
  "1SA": "1 Samuel",
  "2SA": "2 Samuel",
  "1KI": "1 Kings",
  "2KI": "2 Kings",
  "1CH": "1 Chronicles",
  "2CH": "2 Chronicles",
  EZR: "Ezra",
  NEH: "Nehemiah",
  EST: "Esther",
  JOB: "Job",
  PSA: "Psalms",
  PRO: "Proverbs",
  ECC: "Ecclesiastes",
  SNG: "Song of Solomon",
  ISA: "Isaiah",
  JER: "Jeremiah",
  LAM: "Lamentations",
  EZK: "Ezekiel",
  DAN: "Daniel",
  HOS: "Hosea",
  JOL: "Joel",
  AMO: "Amos",
  OBA: "Obadiah",
  JON: "Jonah",
  MIC: "Micah",
  NAM: "Nahum",
  HAB: "Habakkuk",
  ZEP: "Zephaniah",
  HAG: "Haggai",
  ZEC: "Zechariah",
  MAL: "Malachi",
  MAT: "Matthew",
  MRK: "Mark",
  LUK: "Luke",
  JHN: "John",
  ACT: "Acts",
  ROM: "Romans",
  "1CO": "1 Corinthians",
  "2CO": "2 Corinthians",
  GAL: "Galatians",
  EPH: "Ephesians",
  PHP: "Philippians",
  COL: "Colossians",
  "1TH": "1 Thessalonians",
  "2TH": "2 Thessalonians",
  "1TI": "1 Timothy",
  "2TI": "2 Timothy",
  TIT: "Titus",
  PHM: "Philemon",
  HEB: "Hebrews",
  JAS: "James",
  "1PE": "1 Peter",
  "2PE": "2 Peter",
  "1JN": "1 John",
  "2JN": "2 John",
  "3JN": "3 John",
  JUD: "Jude",
  REV: "Revelation",
  TOB: "Tobit",
  JDT: "Judith",
  ESG: "Esther (Greek)",
  WIS: "Wisdom of Solomon",
  SIR: "Sirach",
  BAR: "Baruch",
  LJE: "Letter of Jeremiah",
  S3Y: "Song of the Three Young Men",
  SUS: "Susanna",
  BEL: "Bel and the Dragon",
  "1MA": "1 Maccabees",
  "2MA": "2 Maccabees",
  "3MA": "3 Maccabees",
  "4MA": "4 Maccabees",
  "1ES": "1 Esdras",
  "2ES": "2 Esdras",
  MAN: "Prayer of Manasseh",
  PS2: "Psalm 151",
  ODA: "Odes",
  PSS: "Psalms of Solomon",
};

export interface ParsedUsfm {
  book: string;
  chapter: number | null;
  verse: number | null;
}

/** Parse `JHN`, `JHN.3` or `JHN.3.16`. Returns `null` for anything else. */
export function parseUsfm(usfm: string): ParsedUsfm | null {
  const match = /^([A-Z0-9]{3})(?:\.(\d+))?(?:\.(\d+))?$/.exec(usfm.trim().toUpperCase());
  if (!match) return null;
  const [, book, chapter, verse] = match;
  return {
    book: book as string,
    chapter: chapter ? Number(chapter) : null,
    verse: verse ? Number(verse) : null,
  };
}

/** Book id to title, preferring names from the Bible index for this version. */
export type BookTitles = Readonly<Record<string, string>>;

export function bookTitle(book: string, titles?: BookTitles): string {
  return titles?.[book] ?? USFM_BOOK_NAMES[book] ?? book;
}

/** `JHN.3.16` becomes `John 3:16`. Falls back to the raw USFM if unparseable. */
export function formatReference(usfm: string, titles?: BookTitles): string {
  const parsed = parseUsfm(usfm);
  if (!parsed) return usfm;
  const name = bookTitle(parsed.book, titles);
  if (parsed.chapter === null) return name;
  if (parsed.verse === null) return `${name} ${parsed.chapter}`;
  return `${name} ${parsed.chapter}:${parsed.verse}`;
}

/** `JHN.3.16` becomes `JHN.3`. Used to group verses back to their chapter. */
export function chapterUsfmOf(verseUsfm: string): string | null {
  const parsed = parseUsfm(verseUsfm);
  if (!parsed || parsed.chapter === null) return null;
  return `${parsed.book}.${parsed.chapter}`;
}

/** Sort key that orders verses canonically within a chapter. */
export function verseSortKey(usfm: string): number {
  const parsed = parseUsfm(usfm);
  if (!parsed) return Number.MAX_SAFE_INTEGER;
  return (parsed.chapter ?? 0) * 1000 + (parsed.verse ?? 0);
}
