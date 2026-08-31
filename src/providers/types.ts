/**
 * The provider contract.
 *
 * A provider knows how to obtain YouVersion data from one kind of source. The
 * sync engine talks only to this interface, so the official API provider, a
 * future export-file provider, and any future connector stay interchangeable
 * and independently removable.
 *
 * Providers are read-only in this release. Nothing in this interface can
 * modify, create or delete anything in a user's YouVersion account.
 */
import { Capability, HighlightItem } from "../models/domain";

export type ProviderId = "official-api" | "user-export" | "experimental";

/** One unit of work in a resumable scan: all highlights within a chapter. */
export interface ChapterTask {
  /** Chapter-level USFM, e.g. `JHN.3`. */
  chapterUsfm: string;
  bibleId: number;
}

export interface ProviderContext {
  signal?: AbortSignal;
  /** Called after each unit of work so the UI can show progress. */
  onProgress?: (done: number, total: number, label: string) => void;
}

export interface HighlightSource {
  /**
   * Ordered list of chapters the scan will visit, plus a fingerprint that
   * changes whenever the scope changes so a stale cursor is discarded.
   */
  planScan(ctx: ProviderContext): Promise<{ chapters: ChapterTask[]; fingerprint: string }>;

  /** Highlights within a single chapter. An empty array means none are set. */
  fetchChapterHighlights(task: ChapterTask, ctx: ProviderContext): Promise<HighlightItem[]>;
}

export interface Provider {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly capabilities: readonly Capability[];

  /** Whether this provider can run right now, and why not if it cannot. */
  availability(): Promise<{ usable: boolean; reason: string }>;

  /** `null` when this provider cannot supply highlights. */
  highlights(): HighlightSource | null;
}
