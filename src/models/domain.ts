/**
 * Domain models. These are what the sync engine, Markdown layer and settings
 * speak. They are intentionally free of YouVersion wire-format details so that
 * a second provider (an official data export, say) can produce the same shapes.
 */

/** Every data type the plugin knows how to model, whether or not it is obtainable. */
export type YouVersionDataType = "highlight" | "note" | "bookmark" | "plan";

/**
 * Whether a data type can actually be imported right now, and from where.
 * Rendered into the settings tab and Dashboard.md so the user is never misled.
 */
export type CapabilityState = "available" | "unavailable";

export interface Capability {
  readonly dataType: YouVersionDataType;
  readonly state: CapabilityState;
  /** Plain-language reason, shown verbatim in the UI when `unavailable`. */
  readonly reason: string;
}

/**
 * A single highlighted verse.
 *
 * The official API returns only `{bible_id, passage_id, color}` — no remote row
 * id, and no timestamps. `id` is therefore *derived* from the natural key rather
 * than supplied by YouVersion, and `createdAt`/`updatedAt` are absent by design.
 * See docs/api-research.md for why nothing more is available.
 */
export interface HighlightItem {
  /** Stable synthetic identity: `${bibleId}:${usfm}`. Never a note title. */
  readonly id: string;
  readonly type: "highlight";
  /** Verse-level USFM, e.g. `JHN.3.16`. */
  readonly usfm: string;
  /** Human reference, e.g. `John 3:16`. Derived locally from the Bible index. */
  readonly reference: string;
  readonly bibleId: number;
  readonly bibleVersion?: string;
  /** Lowercase hex without `#`, exactly as the API returns it. */
  readonly color: string;
  readonly canonicalUrl: string;
  /** Only populated when verse text download is enabled and licensing permits. */
  readonly verseText?: string;
  /** Publisher copyright line that must accompany any stored verse text. */
  readonly copyright?: string;
}

export type SyncItem = HighlightItem;

/** Outcome of reconciling one remote item against the vault. */
export type ItemOutcome =
  "created" | "updated" | "unchanged" | "archived" | "conflicted" | "failed";

export interface SyncSummary {
  created: number;
  updated: number;
  unchanged: number;
  archived: number;
  conflicted: number;
  failed: number;
  /** Chapters actually requested from the API during this run. */
  chaptersScanned: number;
  /** Chapters in the configured scope, whether or not this run reached them. */
  chaptersTotal: number;
  startedAt: string;
  finishedAt?: string;
  cancelled: boolean;
  /** Redacted, user-facing messages. Never contains tokens or note bodies. */
  errors: string[];
}

export function emptySummary(chaptersTotal = 0): SyncSummary {
  return {
    created: 0,
    updated: 0,
    unchanged: 0,
    archived: 0,
    conflicted: 0,
    failed: 0,
    chaptersScanned: 0,
    chaptersTotal,
    startedAt: new Date().toISOString(),
    cancelled: false,
    errors: [],
  };
}

/** Per-item bookkeeping, persisted in plugin data — never in user-facing Markdown. */
export interface SyncRecord {
  /** Vault-relative path of the note that represents this item. */
  path: string;
  /** Hash of the sync-managed fields at the time we last wrote them. */
  syncHash: string;
  /**
   * Hash of the managed region exactly as the plugin last wrote it. A mismatch
   * on the next run means the user edited inside the managed markers.
   */
  managedHash?: string;
  lastSyncedAt: string;
  status: "synced" | "missing_remote" | "conflict";
}

/** Resumable position within a chapter scan, so an interrupted run restarts cleanly. */
export interface ScanCursor {
  bibleId: number;
  /** Index into the ordered chapter list produced from the Bible index. */
  nextChapterIndex: number;
  /** Chapter list fingerprint; a mismatch invalidates the cursor. */
  scopeFingerprint: string;
  startedAt: string;
}

export interface SyncState {
  /** Keyed by `HighlightItem.id`. */
  records: Record<string, SyncRecord>;
  cursor: ScanCursor | null;
  lastSuccessfulSyncAt: string | null;
  lastSummary: SyncSummary | null;
  /** Bible index cache, so a resumed run does not refetch the hierarchy. */
  chapterListCache: Record<string, { fingerprint: string; chapters: string[]; cachedAt: string }>;
}

export function emptySyncState(): SyncState {
  return {
    records: {},
    cursor: null,
    lastSuccessfulSyncAt: null,
    lastSummary: null,
    chapterListCache: {},
  };
}
