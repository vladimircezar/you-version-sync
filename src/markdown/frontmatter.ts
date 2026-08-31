/**
 * YAML frontmatter serialisation and block-level merging.
 *
 * We do not pull in a YAML library. Emission is restricted to the scalar shapes
 * this plugin actually writes (string, number, string[]) with strict quoting,
 * and merging is *line-based*: keys the plugin owns are replaced, and every
 * other key the user has added is carried across verbatim, including its
 * original formatting and any nested structure. That keeps unknown YAML we
 * cannot faithfully round-trip from being mangled.
 */

export type FrontmatterValue = string | number | string[];
export type FrontmatterMap = Record<string, FrontmatterValue | undefined>;

const PLAIN_SAFE = /^[A-Za-z0-9][A-Za-z0-9 _./-]*$/;
/** Scalars that YAML would otherwise coerce to a bool/null/number. */
const AMBIGUOUS =
  /^(?:y|Y|yes|Yes|YES|n|N|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF|null|Null|NULL|~|-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)$/;

/** Quote a scalar unless it is unambiguously safe bare. */
export function serializeScalar(value: string | number): string {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : '""';
  if (value === "") return '""';
  if (PLAIN_SAFE.test(value) && !AMBIGUOUS.test(value) && !value.endsWith(" ")) return value;
  // Double-quoted style: escape backslash and quote, and encode control chars.
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

/** Render one `key: value` entry (arrays become block sequences). Omits `undefined`. */
export function serializeEntry(key: string, value: FrontmatterValue | undefined): string[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${key}: []`];
    return [`${key}:`, ...value.map((item) => `  - ${serializeScalar(item)}`)];
  }
  return [`${key}: ${serializeScalar(value)}`];
}

/** Serialise a whole map to frontmatter body lines, skipping `undefined` values. */
export function serializeFrontmatter(map: FrontmatterMap): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(map)) lines.push(...serializeEntry(key, value));
  return lines.join("\n");
}

export interface SplitDocument {
  /** Frontmatter body without the `---` fences, or `null` when there is none. */
  frontmatter: string | null;
  body: string;
}

const FENCE = "---";

/** Split a note into frontmatter body and the remainder. */
export function splitDocument(content: string): SplitDocument {
  const normalized = content.startsWith("﻿") ? content.slice(1) : content;
  if (!normalized.startsWith(`${FENCE}\n`) && !normalized.startsWith(`${FENCE}\r\n`)) {
    return { frontmatter: null, body: normalized };
  }
  const lines = normalized.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === FENCE) {
      return { frontmatter: lines.slice(1, i).join("\n"), body: lines.slice(i + 1).join("\n") };
    }
  }
  // Unterminated fence: treat the whole file as body rather than guessing.
  return { frontmatter: null, body: normalized };
}

interface FrontmatterBlock {
  key: string;
  lines: string[];
}

const TOP_LEVEL_KEY = /^([A-Za-z0-9_][A-Za-z0-9_.$-]*):(?:\s|$)/;

/** Group frontmatter into top-level key blocks, keeping continuation lines attached. */
export function parseFrontmatterBlocks(frontmatter: string): FrontmatterBlock[] {
  const blocks: FrontmatterBlock[] = [];
  let current: FrontmatterBlock | null = null;

  for (const line of frontmatter.split("\n")) {
    const match = TOP_LEVEL_KEY.exec(line);
    if (match) {
      current = { key: match[1] as string, lines: [line] };
      blocks.push(current);
    } else if (current) {
      current.lines.push(line);
    } else if (line.trim() !== "") {
      // Leading junk before any key — keep it under a sentinel so it survives.
      current = { key: "", lines: [line] };
      blocks.push(current);
    }
  }
  return blocks;
}

/**
 * Merge plugin-owned keys into existing frontmatter.
 *
 * Managed keys are replaced in place (or appended, in `managed` order, if new).
 * Keys the user added are preserved exactly as written. A managed key whose new
 * value is `undefined` is removed — that is how we avoid emitting fields the
 * source does not provide.
 */
export function mergeFrontmatter(existing: string | null, managed: FrontmatterMap): string {
  if (existing === null) return serializeFrontmatter(managed);

  const managedKeys = new Set(Object.keys(managed));
  const blocks = parseFrontmatterBlocks(existing);
  const out: string[] = [];
  const emitted = new Set<string>();

  for (const block of blocks) {
    if (!managedKeys.has(block.key)) {
      out.push(...block.lines);
      continue;
    }
    if (emitted.has(block.key)) continue; // Drop duplicate managed keys.
    emitted.add(block.key);
    out.push(...serializeEntry(block.key, managed[block.key]));
  }

  for (const key of Object.keys(managed)) {
    if (!emitted.has(key)) out.push(...serializeEntry(key, managed[key]));
  }

  return out.join("\n").replace(/\n+$/, "");
}

/** Reassemble a document from frontmatter body and content body. */
export function joinDocument(frontmatter: string, body: string): string {
  const trimmedBody = body.replace(/^\n+/, "");
  return `${FENCE}\n${frontmatter}\n${FENCE}\n\n${trimmedBody}`;
}
