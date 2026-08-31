/**
 * The official YouVersion Platform API provider.
 *
 * ## Why this scans chapters
 *
 * `GET /v1/highlights` requires **both** `bible_id` and `passage_id`. There is
 * no "list my highlights" route, no `since` parameter and no pagination over a
 * user's highlights - the only question the API answers is "is this passage
 * highlighted?". A chapter-level `passage_id` is accepted and returns one entry
 * per highlighted verse in that chapter, so walking the ~1,189 chapters of a
 * Bible (or a narrower configured scope) is the only documented way to discover
 * highlights. That is why scope, throttling and a resumable cursor are core
 * rather than optional. See docs/api-research.md.
 *
 * The API also returns no highlight id and no timestamps, so identity is the
 * natural key `bible_id:passage_id` and there is nothing to sync incrementally
 * *by time* - incrementality comes from content hashing and cursor resumption.
 */
import {
  ApiBibleIndex,
  ApiBibleIndexSchema,
  ApiBibleListSchema,
  ApiBibleSchema,
  ApiHighlightCollectionSchema,
  ApiPassageSchema,
} from "../models/api";
import { API_BASE, HIGHLIGHTS_PERMISSION, bibleComUrl } from "../constants";
import { Capability, HighlightItem } from "../models/domain";
import { ChapterTask, HighlightSource, Provider, ProviderContext } from "./types";
import { HttpError, ResilientHttp } from "../sync/http";
import { OAuthClient } from "../auth/oauth";
import { NotConnectedError, TokenStore } from "../auth/tokenStore";
import { BookTitles, formatReference } from "../markdown/reference";
import { redactError } from "../security/redact";
import { CAPABILITIES } from "./capabilities";
import { fnv1a64 } from "../sync/hash";
import { NEW_TESTAMENT_BOOKS, canonChapters } from "../markdown/canon";

export interface ScanScopeConfig {
  scope: "whole" | "new_testament" | "old_testament" | "books";
  /** USFM book ids, used when `scope` is `books`. */
  books: string[];
}

export interface OfficialApiProviderOptions {
  http: ResilientHttp;
  oauth: OAuthClient;
  tokens: TokenStore;
  appKey: string;
  bibleId: number;
  scanScope: ScanScopeConfig;
  /** Fetch and store scripture text alongside each highlight. */
  downloadVerseText: boolean;
}

interface BibleMetadata {
  abbreviation?: string;
  copyright?: string;
  bookTitles: BookTitles;
}

export class OfficialApiProvider implements Provider, HighlightSource {
  readonly id = "official-api" as const;
  readonly displayName = "YouVersion official API";
  readonly capabilities: readonly Capability[] = CAPABILITIES;

  private metadata: BibleMetadata | null = null;
  /** True when the last plan came from the static canon, not the API index. */
  usedCanonFallback = false;
  /** Verse text cache for the current run, keyed by USFM. */
  private readonly verseTextCache = new Map<string, string | undefined>();

  constructor(private readonly options: OfficialApiProviderOptions) {}

  async availability(): Promise<{ usable: boolean; reason: string }> {
    if (!this.options.appKey) {
      return { usable: false, reason: "No App Key configured. Add one in settings." };
    }
    if (!this.options.tokens.isConnected()) {
      return { usable: false, reason: "Not connected to a YouVersion account." };
    }
    if (this.options.tokens.hasPermission(HIGHLIGHTS_PERMISSION)) {
      return { usable: true, reason: "Ready." };
    }
    if (this.options.tokens.permissionsKnown()) {
      return {
        usable: false,
        reason:
          "YouVersion reported that the highlights permission was not granted. Reconnect and " +
          "approve it, and check that your app requests the highlights permission in the " +
          "Platform Portal.",
      };
    }
    // Sign-in told us nothing about permissions. Do not infer a denial from
    // silence - attempt the sync and let a 403 from the API be the answer.
    return {
      usable: true,
      reason: "Ready. YouVersion did not report a permission list; the API will be the authority.",
    };
  }

  highlights(): HighlightSource {
    return this;
  }

  /** Cached Bible metadata for the configured version. Safe to call repeatedly. */
  async bibleMetadata(ctx: ProviderContext = {}): Promise<BibleMetadata> {
    if (this.metadata) return this.metadata;

    const bookTitles: Record<string, string> = {};
    try {
      const index = await this.fetchIndex(ctx);
      for (const book of index.books) if (book.title) bookTitles[book.id] = book.title;
    } catch {
      // No index for this version; references fall back to the built-in names.
    }

    let abbreviation: string | undefined;
    let copyright: string | undefined;
    try {
      const res = await this.get(`/v1/bibles/${this.options.bibleId}`, ctx);
      if (res) {
        const bible = ApiBibleSchema.parse(JSON.parse(res));
        abbreviation = bible.localized_abbreviation ?? bible.abbreviation;
        copyright = bible.copyright;
      }
    } catch {
      // Version metadata is cosmetic; a failure must not abort a sync.
    }

    this.metadata = { abbreviation, copyright, bookTitles };
    return this.metadata;
  }

  async planScan(ctx: ProviderContext): Promise<{ chapters: ChapterTask[]; fingerprint: string }> {
    const wanted = this.bookFilter();
    const chapters: ChapterTask[] = [];
    let source: "index" | "canon" = "index";

    let index: ApiBibleIndex | null = null;
    try {
      index = await this.fetchIndex(ctx);
    } catch {
      // The index can be refused for a Bible this App Key is not licensed for.
      // Highlights may still be readable, so fall back to the static canon
      // rather than refusing to sync a version the user actually reads.
      index = null;
    }

    if (index) {
      for (const book of index.books) {
        if (!wanted(book.id)) continue;
        for (const chapter of book.chapters) {
          if (!chapter.passage_id) continue;
          chapters.push({ chapterUsfm: chapter.passage_id, bibleId: this.options.bibleId });
        }
      }
    }

    if (chapters.length === 0) {
      source = "canon";
      this.usedCanonFallback = true;
      for (const chapterUsfm of canonChapters()) {
        const book = chapterUsfm.split(".")[0] as string;
        if (!wanted(book)) continue;
        chapters.push({ chapterUsfm, bibleId: this.options.bibleId });
      }
    }

    // The fingerprint pins both the scope and the version. Any change to either
    // invalidates a saved cursor, because chapter indices would no longer align.
    const fingerprint = fnv1a64(
      `${this.options.bibleId}|${this.options.scanScope.scope}|` +
        `${[...this.options.scanScope.books].sort().join(",")}|${source}|${chapters.length}|` +
        `${chapters[0]?.chapterUsfm ?? ""}|${chapters[chapters.length - 1]?.chapterUsfm ?? ""}`,
    );

    return { chapters, fingerprint };
  }

  async fetchChapterHighlights(task: ChapterTask, ctx: ProviderContext): Promise<HighlightItem[]> {
    const query = new URLSearchParams({
      bible_id: String(task.bibleId),
      passage_id: task.chapterUsfm,
    });

    const body = await this.get(`/v1/highlights?${query.toString()}`, ctx);
    // 204 means the chapter simply has no highlights - a normal, common answer.
    if (body === null) return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new HttpError(
        200,
        "The highlights endpoint returned a malformed JSON body.",
        "/v1/highlights",
      );
    }

    const collection = ApiHighlightCollectionSchema.safeParse(parsed);
    if (!collection.success) {
      throw new HttpError(
        200,
        "The highlights response did not match the documented schema.",
        "/v1/highlights",
      );
    }

    const meta = await this.bibleMetadata(ctx);
    const items: HighlightItem[] = [];

    for (const raw of collection.data.data) {
      // Guard against a chapter query echoing verses from elsewhere.
      if (raw.bible_id !== task.bibleId) continue;

      const usfm = raw.passage_id.toUpperCase();
      const verseText = this.options.downloadVerseText
        ? await this.fetchVerseText(usfm, ctx)
        : undefined;

      items.push({
        id: `${raw.bible_id}:${usfm}`,
        type: "highlight",
        usfm,
        reference: formatReference(usfm, meta.bookTitles),
        bibleId: raw.bible_id,
        bibleVersion: meta.abbreviation,
        color: raw.color,
        canonicalUrl: bibleComUrl(raw.bible_id, usfm),
        verseText,
        copyright: verseText ? meta.copyright : undefined,
      });
    }

    return items;
  }

  /**
   * Raw highlight query, for diagnostics. Returns the HTTP status alongside the
   * parsed rows so a probe can tell "204, genuinely none" apart from "403, not
   * permitted" and from a schema mismatch.
   */
  async probeHighlights(
    bibleId: number,
    passageId: string,
    ctx: ProviderContext = {},
  ): Promise<{ status: number; count: number; note?: string }> {
    const query = new URLSearchParams({ bible_id: String(bibleId), passage_id: passageId });
    try {
      const body = await this.get(`/v1/highlights?${query.toString()}`, ctx);
      if (body === null) return { status: 204, count: 0 };
      const parsed = ApiHighlightCollectionSchema.safeParse(JSON.parse(body));
      if (!parsed.success) return { status: 200, count: 0, note: "response did not match schema" };
      return { status: 200, count: parsed.data.data.length };
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 0;
      const note = err instanceof HttpError ? err.safeMessage : redactError(err);
      return { status, count: 0, note };
    }
  }

  /** Bible versions this App Key can see, for the version picker and probes. */
  async listBibles(
    ctx: ProviderContext = {},
    allAvailable = false,
  ): Promise<Array<{ id: number; abbreviation: string }>> {
    const query = new URLSearchParams({ "language_ranges[]": "eng" });
    // The default list is only what this App Key is licensed for. The full
    // catalogue is what lets a user find the id of the version they read.
    if (allAvailable) query.set("all_available", "true");
    const body = await this.get(`/v1/bibles?${query.toString()}`, ctx);
    if (body === null) return [];
    const parsed = ApiBibleListSchema.safeParse(JSON.parse(body));
    if (!parsed.success) return [];
    return parsed.data.data.map((b) => ({
      id: b.id,
      abbreviation: b.localized_abbreviation ?? b.abbreviation ?? String(b.id),
    }));
  }

  /** Clear per-run caches so a fresh sync re-reads version metadata. */
  resetRunCaches(): void {
    this.verseTextCache.clear();
  }

  private bookFilter(): (bookId: string) => boolean {
    const { scope, books } = this.options.scanScope;
    if (scope === "whole") return () => true;
    if (scope === "new_testament") return (id) => NEW_TESTAMENT_BOOKS.has(id);
    if (scope === "old_testament") return (id) => !NEW_TESTAMENT_BOOKS.has(id);
    const wanted = new Set(books.map((b) => b.toUpperCase()));
    return (id) => wanted.has(id.toUpperCase());
  }

  private async fetchIndex(ctx: ProviderContext): Promise<ApiBibleIndex> {
    const body = await this.get(`/v1/bibles/${this.options.bibleId}/index`, ctx);
    if (body === null) {
      throw new HttpError(
        204,
        `Bible version ${this.options.bibleId} returned no index.`,
        "/index",
      );
    }
    return ApiBibleIndexSchema.parse(JSON.parse(body));
  }

  /**
   * Verse text is optional and licence-dependent. A failure here degrades the
   * note (no quoted text) rather than failing the highlight.
   */
  private async fetchVerseText(usfm: string, ctx: ProviderContext): Promise<string | undefined> {
    const cached = this.verseTextCache.get(usfm);
    if (this.verseTextCache.has(usfm)) return cached;

    let text: string | undefined;
    try {
      const body = await this.get(
        `/v1/bibles/${this.options.bibleId}/passages/${encodeURIComponent(usfm)}?format=text`,
        ctx,
      );
      if (body !== null) {
        const passage = ApiPassageSchema.safeParse(JSON.parse(body));
        if (passage.success) text = passage.data.content?.trim() || undefined;
      }
    } catch {
      text = undefined;
    }

    this.verseTextCache.set(usfm, text);
    return text;
  }

  /**
   * Authenticated GET. Returns the body, or `null` for a documented 204.
   * Refreshes the access token once on a 401 before giving up, which covers a
   * token that expired mid-scan.
   */
  private async get(
    path: string,
    ctx: ProviderContext,
    retriedAfterRefresh = false,
  ): Promise<string | null> {
    const accessToken = await this.options.tokens.getAccessToken(this.options.oauth);

    let res;
    try {
      res = await this.options.http.send(
        {
          url: `${API_BASE}${path}`,
          method: "GET",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "X-YVP-App-Key": this.options.appKey,
            Accept: "application/json",
          },
        },
        ctx.signal,
      );
    } catch (err) {
      if (err instanceof HttpError && err.status === 401 && !retriedAfterRefresh) {
        await this.forceRefresh();
        return this.get(path, ctx, true);
      }
      throw err;
    }

    if (res.status === 204) return null;
    return res.text;
  }

  /** Expire the cached access token so the next call refreshes it. */
  private async forceRefresh(): Promise<void> {
    if (!this.options.tokens.isConnected()) throw new NotConnectedError();
    this.options.tokens.invalidateAccessToken();
  }
}
