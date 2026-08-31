/**
 * Markdown escaping for values interpolated into generated note bodies.
 *
 * Scripture text and references come from an external API. Even though the
 * source is trusted, unescaped content can silently break a note's structure
 * (a leading `#`, a stray `|` inside a table, a `[[` that invents a wikilink).
 */

/** Characters that carry inline Markdown meaning. */
const INLINE = /([\\`*_{}[\]<>])/g;

/** Escape inline Markdown so the text renders literally. */
export function escapeInline(value: string): string {
  return value.replace(INLINE, "\\$1");
}

/**
 * Escape a value destined for a table cell: inline escaping plus pipes, with
 * newlines folded to `<br>` so the row is not split.
 */
export function escapeTableCell(value: string): string {
  return escapeInline(value).replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

/** Escape link text; brackets and parens would otherwise terminate the link. */
export function escapeLinkText(value: string): string {
  return value.replace(/([\\[\]()])/g, "\\$1");
}

/**
 * Render text as a blockquote, escaping any line that would start a new block
 * (headings, list bullets, fences) while leaving ordinary prose readable.
 */
export function asBlockquote(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => {
      const escaped = line.replace(/^(\s*)([#>*+-]|\d+[.)]|```|~~~)/, "$1\\$2");
      return escaped.trim() === "" ? ">" : `> ${escaped}`;
    })
    .join("\n");
}

/** Sanitise a string for use as a vault filename segment. */
export function sanitizeFilename(value: string): string {
  return (
    value
      // Characters forbidden on Windows/macOS or meaningful to Obsidian links.
      .replace(/[\\/:*?"<>|#^[\]]/g, "-")
      .replace(/\s+/g, " ")
      .replace(/\.+$/, "")
      .trim()
      .slice(0, 120)
  );
}
