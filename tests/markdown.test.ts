import { describe, expect, it } from "vitest";
import {
  asBlockquote,
  escapeInline,
  escapeLinkText,
  escapeTableCell,
  sanitizeFilename,
} from "../src/markdown/escape";
import {
  MissingMarkersError,
  composeBody,
  readManagedRegion,
  readUserRegion,
  replaceManagedRegion,
  splitRegions,
} from "../src/markdown/managedSection";
import { chapterUsfmOf, formatReference, parseUsfm, verseSortKey } from "../src/markdown/reference";
import { highlightId, highlightNotePath, idToSlug } from "../src/markdown/paths";
import { MANAGED_END, MANAGED_START, USER_END, USER_START } from "../src/constants";

void MANAGED_END;

describe("markdown escaping", () => {
  it("neutralises inline markdown", () => {
    expect(escapeInline("a *b* _c_")).toBe("a \\*b\\* \\_c\\_");
    expect(escapeInline("see [[Note]]")).toBe("see \\[\\[Note\\]\\]");
  });

  it("keeps table rows intact", () => {
    expect(escapeTableCell("a | b")).toBe("a \\| b");
    expect(escapeTableCell("line1\nline2")).toBe("line1<br>line2");
  });

  it("escapes link text", () => {
    expect(escapeLinkText("A [b] (c)")).toBe("A \\[b\\] \\(c\\)");
  });

  it("prevents quoted text from opening new blocks", () => {
    const quoted = asBlockquote("# not a heading\n- not a list\nplain");
    expect(quoted).toBe("> \\# not a heading\n> \\- not a list\n> plain");
  });

  it("renders blank lines as bare quote markers", () => {
    expect(asBlockquote("a\n\nb")).toBe("> a\n>\n> b");
  });

  it("strips characters that break filenames or links", () => {
    expect(sanitizeFilename("3034:JHN.3.16")).toBe("3034-JHN.3.16");
    expect(sanitizeFilename('a/b\\c*d?e"f<g>h|i#j^k[l]m')).toBe("a-b-c-d-e-f-g-h-i-j-k-l-m");
    expect(sanitizeFilename("trailing dots...")).toBe("trailing dots");
  });
});

describe("stable identity and paths", () => {
  it("derives identity from the natural key, not the title", () => {
    expect(highlightId(3034, "jhn.3.16")).toBe("3034:JHN.3.16");
  });

  it("produces a filesystem-safe, stable slug", () => {
    expect(idToSlug("3034:JHN.3.16")).toBe("3034-JHN.3.16");
  });

  it("builds the documented note path", () => {
    expect(highlightNotePath("Sources/YouVersion", "3034:JHN.3.16")).toBe(
      "Sources/YouVersion/Highlights/3034-JHN.3.16.md",
    );
  });

  it("is deterministic across calls", () => {
    const a = highlightNotePath("Sources/YouVersion", highlightId(3034, "JHN.3.16"));
    const b = highlightNotePath("Sources/YouVersion", highlightId(3034, "jhn.3.16"));
    expect(a).toBe(b);
  });
});

describe("USFM references", () => {
  it("parses verse, chapter and book forms", () => {
    expect(parseUsfm("JHN.3.16")).toEqual({ book: "JHN", chapter: 3, verse: 16 });
    expect(parseUsfm("JHN.3")).toEqual({ book: "JHN", chapter: 3, verse: null });
    expect(parseUsfm("JHN")).toEqual({ book: "JHN", chapter: null, verse: null });
    expect(parseUsfm("nonsense")).toBeNull();
  });

  it("formats a human reference", () => {
    expect(formatReference("JHN.3.16")).toBe("John 3:16");
    expect(formatReference("1CO.13.4")).toBe("1 Corinthians 13:4");
  });

  it("prefers titles from the Bible index", () => {
    expect(formatReference("JHN.3.16", { JHN: "Juan" })).toBe("Juan 3:16");
  });

  it("falls back to raw USFM when unparseable", () => {
    expect(formatReference("???")).toBe("???");
  });

  it("derives the chapter id", () => {
    expect(chapterUsfmOf("JHN.3.16")).toBe("JHN.3");
    expect(chapterUsfmOf("JHN")).toBeNull();
  });

  it("orders verses canonically", () => {
    expect(verseSortKey("JHN.3.2")).toBeLessThan(verseSortKey("JHN.3.10"));
  });
});

describe("managed and user regions", () => {
  const body = composeBody("\nGENERATED\n", "\n## My notes\n\nmy words\n");

  it("round-trips both regions", () => {
    expect(readManagedRegion(body)).toBe("\nGENERATED\n");
    expect(readUserRegion(body)).toContain("my words");
  });

  it("replaces only the managed region", () => {
    const next = replaceManagedRegion(body, "\nFRESH\n");
    expect(readManagedRegion(next)).toBe("\nFRESH\n");
    expect(next).not.toContain("GENERATED");
    expect(next).toContain("my words");
  });

  it("preserves the user region byte for byte, including odd whitespace", () => {
    const odd = composeBody("\nA\n", "\n\n   trailing spaces   \n\t tabs \n\n");
    const next = replaceManagedRegion(odd, "\nB\n");
    expect(readUserRegion(next)).toBe("\n\n   trailing spaces   \n\t tabs \n\n");
  });

  it("refuses to touch a note whose markers are missing", () => {
    expect(() => replaceManagedRegion("# just a note", "x")).toThrow(MissingMarkersError);
    expect(splitRegions("# just a note")).toBeNull();
  });

  it("refuses a note whose regions are out of order", () => {
    const reordered = `${USER_START}mine${USER_END}\n${MANAGED_START}theirs${MANAGED_END}`;
    expect(splitRegions(reordered)).toBeNull();
  });

  it("keeps content outside both regions", () => {
    const withExtras = `preamble\n${body}postscript`;
    const next = replaceManagedRegion(withExtras, "\nB\n");
    expect(next.startsWith("preamble\n")).toBe(true);
    expect(next.endsWith("postscript")).toBe(true);
  });
});
