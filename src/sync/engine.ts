/**
 * The synchronisation engine.
 *
 * Guarantees, and where each one is enforced:
 *
 *  - **Incremental.** A note is rewritten only when its content hash changes
 *    (`reconcileItem`). An unchanged highlight costs one read and no write.
 *  - **Idempotent.** Identity is the remote natural key, never a title, and the
 *    same input always produces the same path and the same bytes.
 *  - **Restartable.** The chapter cursor is persisted after every chapter, so an
 *    interrupted run resumes where it stopped rather than starting over.
 *  - **Safe after interruption.** Writes go through the atomic-ish vault writer,
 *    and state is saved after the write, never before.
 *  - **Non-destructive.** Nothing is ever deleted. A highlight that disappears
 *    is marked `missing_remote` or archived, according to policy.
 *  - **Respectful of the user's words.** The managed region is rewritten only
 *    when it still matches what we last wrote there.
 */
import {
  HighlightItem,
  ItemOutcome,
  ScanCursor,
  SyncRecord,
  SyncState,
  SyncSummary,
  emptySummary,
} from "../models/domain";
import { ChapterTask, HighlightSource, ProviderContext } from "../providers/types";
import { CancelledError } from "./rateLimit";
import { HttpError } from "./http";
import { NotConnectedError } from "../auth/tokenStore";
import { VaultIO } from "../markdown/vaultIo";
import { archivePath, conflictPath, highlightNotePath } from "../markdown/paths";
import {
  HighlightGroup,
  RenderedItem,
  asGroupItem,
  asVerseItem,
  defaultUserBody,
} from "../markdown/note";
import { joinDocument, mergeFrontmatter, splitDocument } from "../markdown/frontmatter";
import {
  MissingMarkersError,
  composeBody,
  replaceManagedRegion,
  splitRegions,
} from "../markdown/managedSection";
import { fnv1a64 } from "./hash";
import { redactError } from "../security/redact";
import type { ConflictPolicy, HighlightOrganization, RemovalPolicy } from "../settings";
import { bibleComUrl } from "../constants";
import { formatReference, verseSortKey } from "../markdown/reference";

export interface EngineOptions {
  io: VaultIO;
  source: HighlightSource;
  destinationRoot: string;
  conflictPolicy: ConflictPolicy;
  removalPolicy: RemovalPolicy;
  /** One note per verse, or one note per chapter. Defaults to per-verse. */
  organization?: HighlightOrganization;
  /** Persist sync state. Called after every chapter so a crash loses at most one. */
  saveState: (state: SyncState) => Promise<void>;
  now?: () => Date;
  onProgress?: (summary: SyncSummary, label: string) => void;
}

export class SyncEngine {
  private readonly now: () => Date;

  constructor(private readonly options: EngineOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Run a full pass over the configured scope.
   *
   * `state` is mutated in place and persisted as the run proceeds; the caller
   * owns it and should hand back the same object on the next run so the cursor
   * survives.
   */
  async run(state: SyncState, signal?: AbortSignal): Promise<SyncSummary> {
    const ctx: ProviderContext = { signal };
    const summary = emptySummary();

    let plan: { chapters: ChapterTask[]; fingerprint: string };
    try {
      plan = await this.options.source.planScan(ctx);
    } catch (err) {
      if (err instanceof CancelledError) {
        summary.cancelled = true;
        summary.finishedAt = this.nowIso();
        return summary;
      }
      summary.errors.push(`Could not plan the scan: ${redactError(err)}`);
      summary.failed += 1;
      summary.finishedAt = this.nowIso();
      state.lastSummary = summary;
      await this.options.saveState(state);
      return summary;
    }

    summary.chaptersTotal = plan.chapters.length;

    // Resume only when the saved cursor still describes this exact scope.
    const cursor = this.resumableCursor(state.cursor, plan.fingerprint);
    let startIndex = cursor?.nextChapterIndex ?? 0;
    if (startIndex >= plan.chapters.length) startIndex = 0;

    // Ids seen this run, so removal detection only considers the scanned scope.
    const seen = new Set<string>();
    // Everything we already know about, restricted to the chapters in scope.
    const inScopePrefixes = new Set(plan.chapters.map((c) => c.chapterUsfm));

    for (let i = startIndex; i < plan.chapters.length; i++) {
      const task = plan.chapters[i] as ChapterTask;

      if (signal?.aborted) {
        summary.cancelled = true;
        break;
      }

      try {
        const highlights = await this.options.source.fetchChapterHighlights(task, ctx);
        for (const rendered of this.toRenderedItems(task, highlights)) {
          seen.add(rendered.id);
          const outcome = await this.reconcileItem(rendered, state);
          summary[outcome] += 1;
        }
      } catch (err) {
        if (err instanceof CancelledError) {
          summary.cancelled = true;
          break;
        }
        if (err instanceof NotConnectedError) {
          summary.errors.push(redactError(err));
          summary.failed += 1;
          break;
        }
        summary.failed += 1;
        summary.errors.push(`${task.chapterUsfm}: ${describe(err)}`);
      }

      summary.chaptersScanned += 1;

      // Persist the cursor *after* the chapter is fully reconciled, so a crash
      // replays that chapter rather than skipping it. Replay is safe: the
      // engine is idempotent.
      state.cursor = {
        bibleId: task.bibleId,
        nextChapterIndex: i + 1,
        scopeFingerprint: plan.fingerprint,
        startedAt: cursor?.startedAt ?? summary.startedAt,
      };
      await this.options.saveState(state);
      this.options.onProgress?.(summary, task.chapterUsfm);
    }

    if (!summary.cancelled && summary.chaptersScanned + startIndex >= plan.chapters.length) {
      // Only a complete pass can conclude that something has disappeared.
      await this.reconcileRemovals(seen, inScopePrefixes, state, summary);
      state.cursor = null;
      state.lastSuccessfulSyncAt = this.nowIso();
    }

    summary.finishedAt = this.nowIso();
    state.lastSummary = summary;
    await this.options.saveState(state);
    return summary;
  }

  /**
   * Create, update, skip or flag one highlight.
   *
   * The decision order matters: an unchanged hash short-circuits before any
   * write, and a user edit inside the managed region takes precedence over a
   * remote change.
   */
  private async reconcileItem(item: RenderedItem, state: SyncState): Promise<ItemOutcome> {
    const path = highlightNotePath(this.options.destinationRoot, item.id);
    const existingRecord = state.records[item.id];
    const nowIso = this.nowIso();
    const newHash = item.syncHash;

    let existing: string | null = null;
    try {
      if (await this.options.io.exists(path)) existing = await this.options.io.read(path);
    } catch (err) {
      return this.fail(state, item, path, `could not read the existing note: ${describe(err)}`);
    }

    // Brand-new note.
    if (existing === null) {
      const managedBody = item.managedBody();
      const frontmatter = mergeFrontmatter(
        null,
        item.frontmatter({ importedAt: nowIso, lastSyncedAt: nowIso, syncStatus: "synced" }),
      );
      const content = joinDocument(frontmatter, composeBody(managedBody, defaultUserBody()));
      try {
        await this.options.io.create(path, content);
      } catch (err) {
        return this.fail(state, item, path, `could not write the note: ${describe(err)}`);
      }
      state.records[item.id] = {
        path,
        syncHash: newHash,
        lastSyncedAt: nowIso,
        status: "synced",
        managedHash: fnv1a64(managedBody),
      } satisfies SyncRecord;
      return "created";
    }

    const doc = splitDocument(existing);
    const regions = splitRegions(doc.body);

    // A note without markers is one the user restructured (or something else
    // wrote). Never rewrite it wholesale.
    if (!regions) {
      return this.recordConflict(
        state,
        item,
        path,
        existing,
        "the sync markers are missing, so the managed region could not be located",
      );
    }

    const currentManagedHash = fnv1a64(regions.managed);
    const managedWasEdited =
      existingRecord?.managedHash !== undefined &&
      existingRecord.managedHash !== currentManagedHash;

    if (managedWasEdited && this.options.conflictPolicy !== "overwrite") {
      return this.recordConflict(
        state,
        item,
        path,
        existing,
        "the managed region was edited locally",
      );
    }

    // Nothing changed remotely and the managed region is intact: leave the file
    // completely alone, including its `last_synced_at`, so unchanged notes do
    // not churn the vault (and any sync/backup tool watching it).
    if (
      existingRecord?.syncHash === newHash &&
      !managedWasEdited &&
      existingRecord.status === "synced"
    ) {
      return "unchanged";
    }

    const managedBody = item.managedBody();
    const importedAt = readImportedAt(doc.frontmatter) ?? existingRecord?.lastSyncedAt ?? nowIso;

    // Re-derive the splice inside process() rather than writing the string we
    // built from the copy read above: process() hands us whatever is on disk at
    // this instant, so an edit made in the meantime is carried through instead
    // of being overwritten. If the markers vanished in that window, the throw
    // aborts the write and we fall through to the conflict path.
    try {
      await this.options.io.process(path, (current) => {
        const fresh = splitDocument(current);
        return joinDocument(
          mergeFrontmatter(
            fresh.frontmatter,
            item.frontmatter({ importedAt, lastSyncedAt: nowIso, syncStatus: "synced" }),
          ),
          replaceManagedRegion(fresh.body, managedBody),
        );
      });
    } catch (err) {
      if (err instanceof MissingMarkersError) {
        return this.recordConflict(state, item, path, existing, describe(err));
      }
      return this.fail(state, item, path, `could not write the note: ${describe(err)}`);
    }

    state.records[item.id] = {
      path,
      syncHash: newHash,
      lastSyncedAt: nowIso,
      status: "synced",
      managedHash: fnv1a64(managedBody),
    } satisfies SyncRecord;
    return "updated";
  }

  /**
   * Handle highlights we have notes for that the remote no longer reports.
   *
   * Only ids inside the scanned scope are considered: a note from a book the
   * user has since excluded has not disappeared, it merely was not looked at.
   */
  private async reconcileRemovals(
    seen: Set<string>,
    scannedChapters: Set<string>,
    state: SyncState,
    summary: SyncSummary,
  ): Promise<void> {
    if (this.options.removalPolicy === "ignore") return;

    for (const [id, record] of Object.entries(state.records)) {
      if (seen.has(id)) continue;
      if (record.status === "missing_remote") continue;

      const chapter = chapterOfId(id);
      if (!chapter || !scannedChapters.has(chapter)) continue;

      try {
        if (this.options.removalPolicy === "archive") {
          await this.archiveNote(id, record, state);
        } else {
          await this.markMissing(id, record, state);
        }
        summary.archived += 1;
      } catch (err) {
        summary.failed += 1;
        summary.errors.push(`${id}: could not apply the removal policy: ${describe(err)}`);
      }
    }
  }

  private async markMissing(id: string, record: SyncRecord, state: SyncState): Promise<void> {
    if (!(await this.options.io.exists(record.path))) {
      // The user deleted the note themselves; forget it rather than recreating.
      delete state.records[id];
      return;
    }
    const stampedAt = this.nowIso();
    await this.options.io.process(record.path, (current) => {
      const doc = splitDocument(current);
      return joinDocument(
        mergeFrontmatter(doc.frontmatter, {
          sync_status: "missing_remote",
          last_synced_at: stampedAt,
        }),
        doc.body,
      );
    });
    state.records[id] = { ...record, status: "missing_remote", lastSyncedAt: stampedAt };
  }

  private async archiveNote(id: string, record: SyncRecord, state: SyncState): Promise<void> {
    if (!(await this.options.io.exists(record.path))) {
      delete state.records[id];
      return;
    }
    const existing = await this.options.io.read(record.path);
    const doc = splitDocument(existing);
    const frontmatter = mergeFrontmatter(doc.frontmatter, {
      sync_status: "missing_remote",
      last_synced_at: this.nowIso(),
    });
    const target = archivePath(this.options.destinationRoot, id);
    // Copy, verify the copy landed, and only then trash the original - a failure
    // anywhere in here loses nothing. Trashing rather than deleting means the
    // user can still recover the note.
    await this.options.io.write(target, joinDocument(frontmatter, doc.body));
    if (!(await this.options.io.exists(target))) {
      throw new Error("The archive copy could not be written; the note was left in place.");
    }
    await this.options.io.trash(record.path);
    state.records[id] = {
      ...record,
      path: target,
      status: "missing_remote",
      lastSyncedAt: this.nowIso(),
    };
  }

  /**
   * Record a conflict without losing either version: the user's note is left
   * byte-for-byte untouched, and (under the default policy) the version sync
   * would have written is saved to a sidecar for comparison.
   */
  private async recordConflict(
    state: SyncState,
    item: RenderedItem,
    path: string,
    _existing: string,
    reason: string,
  ): Promise<ItemOutcome> {
    const nowIso = this.nowIso();

    if (this.options.conflictPolicy === "preserve") {
      const sidecar = conflictPath(this.options.destinationRoot, item.id);
      const frontmatter = mergeFrontmatter(
        null,
        item.frontmatter({
          importedAt: nowIso,
          lastSyncedAt: nowIso,
          syncStatus: "conflict",
        }),
      );
      const body =
        `> [!warning] Sync conflict\n` +
        `> The note at \`${path}\` was not modified because ${reason}.\n` +
        `> This file holds the version YouVersion Sync would have written. Merge what you want\n` +
        `> into your note, then delete this file.\n\n` +
        composeBody(item.managedBody(), defaultUserBody());
      try {
        await this.options.io.write(sidecar, joinDocument(frontmatter, body));
      } catch {
        // Even if the sidecar cannot be written, the conflict is still reported.
      }
    }

    const previous = state.records[item.id];
    state.records[item.id] = {
      path,
      syncHash: previous?.syncHash ?? "",
      lastSyncedAt: nowIso,
      status: "conflict",
      managedHash: previous?.managedHash,
    } satisfies SyncRecord;
    return "conflicted";
  }

  private fail(state: SyncState, item: RenderedItem, path: string, reason: string): ItemOutcome {
    const previous = state.records[item.id];
    if (previous) state.records[item.id] = { ...previous, lastSyncedAt: this.nowIso() };
    else
      state.records[item.id] = {
        path,
        syncHash: "",
        lastSyncedAt: this.nowIso(),
        status: "conflict",
      };
    void reason;
    return "failed";
  }

  /**
   * Turn a chapter's verse highlights into the notes this vault should hold.
   *
   * Per-verse mode maps one to one. Chapter mode collapses them into a single
   * note whose identity is the chapter, so switching modes changes which files
   * exist but never corrupts either set - the ids do not collide.
   */
  private toRenderedItems(task: ChapterTask, highlights: HighlightItem[]): RenderedItem[] {
    if (highlights.length === 0) return [];

    if ((this.options.organization ?? "verse") === "verse") {
      return highlights.map(asVerseItem);
    }

    const ordered = [...highlights].sort((a, b) => verseSortKey(a.usfm) - verseSortKey(b.usfm));
    const first = ordered[0] as HighlightItem;
    const group: HighlightGroup = {
      chapterUsfm: task.chapterUsfm,
      bibleId: task.bibleId,
      reference: formatReference(task.chapterUsfm),
      bibleVersion: first.bibleVersion,
      canonicalUrl: bibleComUrl(task.bibleId, task.chapterUsfm),
      items: ordered,
    };
    return [asGroupItem(group)];
  }

  private resumableCursor(cursor: ScanCursor | null, fingerprint: string): ScanCursor | null {
    if (!cursor) return null;
    return cursor.scopeFingerprint === fingerprint ? cursor : null;
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
}

/** `3034:JHN.3.16` becomes `JHN.3`, matching the chapter task ids. */
function chapterOfId(id: string): string | null {
  const usfm = id.split(":")[1];
  if (!usfm) return null;
  const parts = usfm.split(".");
  return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : null;
}

/** Preserve the original import timestamp across updates. */
function readImportedAt(frontmatter: string | null): string | undefined {
  if (!frontmatter) return undefined;
  const match = /^imported_at:\s*"?([^"\n]+)"?\s*$/m.exec(frontmatter);
  return match?.[1]?.trim();
}

function describe(err: unknown): string {
  if (err instanceof HttpError) return err.safeMessage;
  return redactError(err);
}
