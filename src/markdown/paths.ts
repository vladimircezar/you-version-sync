/**
 * Vault path construction.
 *
 * Filenames derive from the stable item id, never from the reference or any
 * other display text. A user renaming "John 3:16" in their own head, or a
 * publisher changing a book title, must not orphan an existing note.
 */
import { normalizePath } from "obsidian";
import { sanitizeFilename } from "./escape";

export const FOLDERS = {
  highlights: "Highlights",
  notes: "Notes",
  bookmarks: "Bookmarks",
  plans: "Plans",
  indexes: "Indexes",
  archive: "Archive",
} as const;

/**
 * The identity of a highlight. The API returns no row id, so the natural key
 * (Bible version + verse) *is* the identity. Stable across syncs by
 * construction.
 */
export function highlightId(bibleId: number, usfm: string): string {
  return `${bibleId}:${usfm.toUpperCase()}`;
}

/** Filesystem-safe rendering of an item id, e.g. `3034:JHN.3.16` to `3034-JHN.3.16`. */
export function idToSlug(id: string): string {
  return sanitizeFilename(id.replace(/:/g, "-"));
}

export function joinPath(...segments: string[]): string {
  return normalizePath(segments.filter((s) => s.length > 0).join("/"));
}

export function highlightNotePath(root: string, id: string): string {
  return joinPath(root, FOLDERS.highlights, `${idToSlug(id)}.md`);
}

export function archivePath(root: string, id: string): string {
  return joinPath(root, FOLDERS.archive, `${idToSlug(id)}.md`);
}

export function indexPath(root: string, name: string): string {
  return joinPath(root, FOLDERS.indexes, `${name}.md`);
}

export function dashboardPath(root: string): string {
  return joinPath(root, "Dashboard.md");
}

/**
 * Sidecar path for a conflicted note. The plugin's version is written here so
 * the user can compare, and their own note is left exactly as they left it.
 */
export function conflictPath(root: string, id: string): string {
  return joinPath(root, FOLDERS.highlights, `${idToSlug(id)}.sync-conflict.md`);
}
