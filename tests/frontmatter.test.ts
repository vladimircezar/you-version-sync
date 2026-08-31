import { describe, expect, it } from "vitest";
import {
  joinDocument,
  mergeFrontmatter,
  parseFrontmatterBlocks,
  serializeEntry,
  serializeFrontmatter,
  serializeScalar,
  splitDocument,
} from "../src/markdown/frontmatter";

describe("scalar serialisation", () => {
  it("leaves unambiguous scalars bare", () => {
    expect(serializeScalar("John 3:16".replace(":", ""))).toBe("John 316");
    expect(serializeScalar("youversion")).toBe("youversion");
  });

  it("quotes anything YAML would reinterpret", () => {
    expect(serializeScalar("John 3:16")).toBe('"John 3:16"');
    expect(serializeScalar("yes")).toBe('"yes"');
    expect(serializeScalar("no")).toBe('"no"');
    expect(serializeScalar("null")).toBe('"null"');
    expect(serializeScalar("1234")).toBe('"1234"');
    expect(serializeScalar("")).toBe('""');
  });

  it("escapes quotes, backslashes and newlines", () => {
    expect(serializeScalar('a "b" c')).toBe('"a \\"b\\" c"');
    expect(serializeScalar("a\\b")).toBe('"a\\\\b"');
    expect(serializeScalar("line1\nline2")).toBe('"line1\\nline2"');
  });

  it("emits numbers unquoted", () => {
    expect(serializeScalar(3034)).toBe("3034");
  });
});

describe("entry serialisation", () => {
  it("renders arrays as block sequences", () => {
    expect(serializeEntry("tags", ["source/youversion", "bible/highlight"])).toEqual([
      "tags:",
      "  - source/youversion",
      "  - bible/highlight",
    ]);
  });

  it("omits undefined values entirely, rather than emitting a blank field", () => {
    expect(serializeEntry("created_at", undefined)).toEqual([]);
    expect(serializeFrontmatter({ a: "1", b: undefined })).toBe('a: "1"');
  });
});

describe("document splitting", () => {
  it("separates frontmatter from body", () => {
    const doc = splitDocument("---\na: 1\n---\n\nbody text\n");
    expect(doc.frontmatter).toBe("a: 1");
    expect(doc.body).toBe("\nbody text\n");
  });

  it("treats a file with no frontmatter as all body", () => {
    expect(splitDocument("just text").frontmatter).toBeNull();
  });

  it("does not guess at an unterminated fence", () => {
    const doc = splitDocument("---\na: 1\nstill going");
    expect(doc.frontmatter).toBeNull();
    expect(doc.body).toBe("---\na: 1\nstill going");
  });
});

describe("frontmatter merging", () => {
  it("replaces managed keys and preserves user keys verbatim", () => {
    const existing = [
      "source: youversion",
      "my_rating: 5",
      'color: "#44aa44"',
      "cssclass: verse",
    ].join("\n");
    const merged = mergeFrontmatter(existing, { color: "#ff0000", sync_status: "synced" });

    expect(merged).toContain("my_rating: 5");
    expect(merged).toContain("cssclass: verse");
    expect(merged).toContain('color: "#ff0000"');
    expect(merged).not.toContain("#44aa44");
    expect(merged).toContain("sync_status: synced");
  });

  it("keeps the user's nested structures intact", () => {
    const existing = ["aliases:", "  - Jn 3:16", "  - the verse", "usfm: JHN.3.16"].join("\n");
    const merged = mergeFrontmatter(existing, { usfm: "JHN.3.17" });
    expect(merged).toContain("  - Jn 3:16");
    expect(merged).toContain("  - the verse");
    expect(merged).toContain("usfm: JHN.3.17");
  });

  it("removes a managed key whose value is now undefined", () => {
    const merged = mergeFrontmatter("created_at: 2020-01-01\nusfm: JHN.3.16", {
      created_at: undefined,
      usfm: "JHN.3.16",
    });
    expect(merged).not.toContain("created_at");
    expect(merged).toContain("usfm: JHN.3.16");
  });

  it("collapses duplicate managed keys into one", () => {
    const merged = mergeFrontmatter("color: a\ncolor: b", { color: "c" });
    expect(merged.match(/^color:/gm)).toHaveLength(1);
  });

  it("appends managed keys that are not present yet", () => {
    expect(mergeFrontmatter("mine: 1", { sync_hash: "abc" })).toBe("mine: 1\nsync_hash: abc");
  });
});

describe("block parsing", () => {
  it("attaches continuation lines to their key", () => {
    const blocks = parseFrontmatterBlocks("tags:\n  - a\n  - b\nother: 1");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.lines).toEqual(["tags:", "  - a", "  - b"]);
  });
});

describe("document assembly", () => {
  it("round-trips through split and join", () => {
    const doc = joinDocument("a: 1", "body\n");
    expect(doc).toBe("---\na: 1\n---\n\nbody\n");
    expect(splitDocument(doc).frontmatter).toBe("a: 1");
  });
});
