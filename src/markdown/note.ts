/**
 * Rendering a highlight into Markdown.
 *
 * Two rules govern everything here:
 *
 *  1. Never fabricate metadata. The highlights API supplies a Bible id, a USFM
 *     passage id and a color - nothing else. There is no remote row id and
 *     there are no timestamps, so `created_at` / `updated_at` are simply absent
 *     rather than invented. `imported_at` and `last_synced_at` describe *our*
 *     actions and are therefore legitimate.
 *  2. Only the managed region and the managed frontmatter keys belong to sync.
 */
import { HighlightItem } from "../models/domain";
import { FrontmatterMap } from "./frontmatter";
import { asBlockquote, escapeInline } from "./escape";
import { hashFields } from "../sync/hash";

/** Frontmatter keys the plugin owns. Anything else in a note is the user's. */
export const MANAGED_FRONTMATTER_KEYS = [
  "source",
  "youversion_type",
  "youversion_id",
  "reference",
  "usfm",
  "bible_version_id",
  "bible_version",
  "color",
  "youversion_url",
  "imported_at",
  "last_synced_at",
  "sync_hash",
  "sync_status",
  "tags",
] as const;

export interface RenderContext {
  /** ISO-8601 UTC. Preserved from the existing note when one is already present. */
  importedAt: string;
  lastSyncedAt: string;
  syncStatus: "synced" | "missing_remote" | "conflict";
}

/**
 * Hash of exactly the fields sync controls. Deliberately excludes `last_synced_at`
 * (it changes every run) and `imported_at` (it never changes), so an unchanged
 * remote highlight hashes identically run after run and the note is left alone.
 */
export function computeSyncHash(item: HighlightItem): string {
  return hashFields({
    id: item.id,
    usfm: item.usfm,
    bibleId: item.bibleId,
    color: item.color,
    reference: item.reference,
    bibleVersion: item.bibleVersion,
    verseText: item.verseText,
    copyright: item.copyright,
  });
}

export function buildFrontmatter(item: HighlightItem, ctx: RenderContext): FrontmatterMap {
  return {
    source: "youversion",
    youversion_type: "highlight",
    youversion_id: item.id,
    reference: item.reference,
    usfm: item.usfm,
    bible_version_id: item.bibleId,
    bible_version: item.bibleVersion,
    color: `#${item.color}`,
    youversion_url: item.canonicalUrl,
    // No created_at / updated_at: the API does not expose highlight timestamps.
    imported_at: ctx.importedAt,
    last_synced_at: ctx.lastSyncedAt,
    sync_hash: computeSyncHash(item),
    sync_status: ctx.syncStatus,
    tags: ["source/youversion", "bible/highlight"],
  };
}

/**
 * The generated body. Everything between the managed markers is rewritten on
 * each sync, so nothing the user might want to keep may live here.
 */
export function renderManagedBody(item: HighlightItem): string {
  const lines: string[] = ["", `# ${escapeInline(item.reference)}`, ""];

  if (item.verseText && item.verseText.trim().length > 0) {
    lines.push(asBlockquote(item.verseText.trim()), "");
  } else {
    lines.push(
      `*Verse text is not stored locally. Open the reference in YouVersion to read it.*`,
      "",
    );
  }

  lines.push(`[Open in YouVersion](${item.canonicalUrl})`, "");

  const version = item.bibleVersion
    ? `${item.bibleVersion} (${item.bibleId})`
    : String(item.bibleId);
  lines.push(`Highlighted in **${escapeInline(version)}** with color \`#${item.color}\`.`, "");

  if (item.copyright && item.verseText) {
    lines.push(`> [!quote]- Copyright`, `> ${escapeInline(item.copyright)}`, "");
  }

  return lines.join("\n");
}

/** Placeholder body for the user-owned region of a brand-new note. */
export function defaultUserBody(): string {
  return ["", "## My notes", "", "", ""].join("\n");
}

/**
 * What the sync engine actually reconciles.
 *
 * Both organization strategies - one note per verse, and one note per chapter -
 * reduce to this, so the engine has a single code path and neither strategy can
 * drift from the other's guarantees.
 */
export interface RenderedItem {
  /** Stable identity, and the basis of the filename. */
  readonly id: string;
  /** Hash of the sync-controlled content, for change detection. */
  readonly syncHash: string;
  readonly frontmatter: (ctx: RenderContext) => FrontmatterMap;
  readonly managedBody: () => string;
}

/** One note per highlighted verse. */
export function asVerseItem(item: HighlightItem): RenderedItem {
  return {
    id: item.id,
    syncHash: computeSyncHash(item),
    frontmatter: (ctx) => buildFrontmatter(item, ctx),
    managedBody: () => renderManagedBody(item),
  };
}

/** All highlights in one chapter, collected into a single note. */
export interface HighlightGroup {
  /** Chapter-level USFM, e.g. `JHN.3`. */
  readonly chapterUsfm: string;
  readonly bibleId: number;
  readonly reference: string;
  readonly bibleVersion?: string;
  readonly canonicalUrl: string;
  /** Verse highlights, in canonical order. Never empty. */
  readonly items: readonly HighlightItem[];
}

export function computeGroupSyncHash(group: HighlightGroup): string {
  return hashFields({
    id: `${group.bibleId}:${group.chapterUsfm}`,
    bibleVersion: group.bibleVersion,
    // Each verse contributes its own hash, so any color or text change shows up.
    verses: group.items.map((item) => `${item.usfm}#${computeSyncHash(item)}`).join(","),
  });
}

export function buildGroupFrontmatter(group: HighlightGroup, ctx: RenderContext): FrontmatterMap {
  return {
    source: "youversion",
    youversion_type: "highlight-chapter",
    youversion_id: `${group.bibleId}:${group.chapterUsfm}`,
    reference: group.reference,
    usfm: group.chapterUsfm,
    bible_version_id: group.bibleId,
    bible_version: group.bibleVersion,
    // No single color for a chapter: each verse carries its own in the body.
    color: undefined,
    youversion_url: group.canonicalUrl,
    highlight_count: group.items.length,
    imported_at: ctx.importedAt,
    last_synced_at: ctx.lastSyncedAt,
    sync_hash: computeGroupSyncHash(group),
    sync_status: ctx.syncStatus,
    tags: ["source/youversion", "bible/highlight"],
  };
}

export function renderGroupManagedBody(group: HighlightGroup): string {
  const lines: string[] = ["", `# ${escapeInline(group.reference)}`, ""];

  const version = group.bibleVersion
    ? `${group.bibleVersion} (${group.bibleId})`
    : String(group.bibleId);
  lines.push(
    `${group.items.length} highlighted verse${group.items.length === 1 ? "" : "s"} in ` +
      `**${escapeInline(version)}**.`,
    "",
  );

  for (const item of group.items) {
    lines.push(`## ${escapeInline(item.reference)}`, "");
    if (item.verseText && item.verseText.trim().length > 0) {
      lines.push(asBlockquote(item.verseText.trim()), "");
    }
    lines.push(`Color \`#${item.color}\` - [Open in YouVersion](${item.canonicalUrl})`, "");
  }

  const copyright = group.items.find((item) => item.copyright && item.verseText)?.copyright;
  if (copyright) {
    lines.push(`> [!quote]- Copyright`, `> ${escapeInline(copyright)}`, "");
  }

  return lines.join("\n");
}

/** One note per chapter. */
export function asGroupItem(group: HighlightGroup): RenderedItem {
  return {
    id: `${group.bibleId}:${group.chapterUsfm}`,
    syncHash: computeGroupSyncHash(group),
    frontmatter: (ctx) => buildGroupFrontmatter(group, ctx),
    managedBody: () => renderGroupManagedBody(group),
  };
}
