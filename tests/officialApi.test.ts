/**
 * Official API provider tests against mocked HTTP. No live account, no App Key.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { OfficialApiProvider } from "../src/providers/officialApi";
import { ResilientHttp, HttpRequest, HttpResponse } from "../src/sync/http";
import { DEFAULT_RETRY_POLICY } from "../src/sync/rateLimit";
import { TokenStore } from "../src/auth/tokenStore";
import type { OAuthClient } from "../src/auth/oauth";
import { BIBLE_INDEX, BIBLE_META, CHAPTER_JHN3, CORRUPT_HIGHLIGHTS } from "./fixtures/highlights";

interface Route {
  match: RegExp;
  status?: number;
  body?: unknown;
}

function makeProvider(
  routes: Route[],
  opts: {
    downloadVerseText?: boolean;
    scope?: "whole" | "new_testament" | "old_testament" | "books";
    books?: string[];
    appKey?: string;
  } = {},
) {
  const requests: HttpRequest[] = [];

  const http = new ResilientHttp({
    transport: async (req): Promise<HttpResponse> => {
      requests.push(req);
      const route = routes.find((r) => r.match.test(req.url));
      if (!route) return { status: 404, headers: {}, text: '{"message":"no route"}' };
      return {
        status: route.status ?? 200,
        headers: {},
        text: route.body === undefined ? "" : JSON.stringify(route.body),
      };
    },
    policy: { ...DEFAULT_RETRY_POLICY, minIntervalMs: 0, maxAttempts: 1 },
    sleepFn: async () => undefined,
  });

  const tokens = new TokenStore({
    persistence: "session",
    save: async () => undefined,
    load: async () => null,
  });

  const oauth = {} as OAuthClient;

  const provider = new OfficialApiProvider({
    http,
    oauth,
    tokens,
    appKey: opts.appKey ?? "test-app-key",
    bibleId: 3034,
    scanScope: { scope: opts.scope ?? "whole", books: opts.books ?? [] },
    downloadVerseText: opts.downloadVerseText ?? false,
  });

  return { provider, tokens, requests };
}

async function connect(tokens: TokenStore, permissions = ["highlights"]) {
  await tokens.store({
    accessToken: "access-token-value",
    refreshToken: "refresh-token-value",
    expiresAt: Date.now() + 3_600_000,
    grantedPermissions: permissions,
  });
}

const INDEX_ROUTE: Route = { match: /\/v1\/bibles\/3034\/index/, body: BIBLE_INDEX };
const META_ROUTE: Route = { match: /\/v1\/bibles\/3034$/, body: BIBLE_META };

let base: Route[];
beforeEach(() => {
  base = [INDEX_ROUTE, META_ROUTE];
});

describe("availability", () => {
  it("refuses without an App Key", async () => {
    const { provider, tokens } = makeProvider(base, { appKey: "" });
    await connect(tokens);
    await expect(provider.availability()).resolves.toMatchObject({
      usable: false,
      reason: expect.stringContaining("No App Key"),
    });
  });

  it("is ready once connected with the highlights permission", async () => {
    const { provider, tokens } = makeProvider(base);
    await connect(tokens);
    await expect(provider.availability()).resolves.toMatchObject({ usable: true });
  });

  it("refuses when not connected", async () => {
    const { provider } = makeProvider(base);
    await expect(provider.availability()).resolves.toMatchObject({
      usable: false,
      reason: expect.stringContaining("Not connected"),
    });
  });

  it("refuses when YouVersion reported that highlights were not granted", async () => {
    const { provider, tokens } = makeProvider(base);
    await tokens.store({
      accessToken: "a",
      refreshToken: "r",
      expiresAt: Date.now() + 3_600_000,
      grantedPermissions: [],
      permissionsReported: true,
    });
    await expect(provider.availability()).resolves.toMatchObject({
      usable: false,
      reason: expect.stringContaining("not granted"),
    });
  });

  it("proceeds when YouVersion reported no permission list at all", async () => {
    // Silence is not a denial: attempt the sync and let a 403 be the answer.
    const { provider, tokens } = makeProvider(base);
    await connect(tokens, []);
    await expect(provider.availability()).resolves.toMatchObject({ usable: true });
  });
});

describe("scan planning", () => {
  it("lists every chapter in the index for the whole-Bible scope", async () => {
    const { provider, tokens } = makeProvider(base);
    await connect(tokens);
    const plan = await provider.planScan({});
    expect(plan.chapters.map((c) => c.chapterUsfm)).toEqual(["JHN.1", "JHN.2", "JHN.3", "GEN.1"]);
  });

  it("restricts to the New Testament", async () => {
    const { provider, tokens } = makeProvider(base, { scope: "new_testament" });
    await connect(tokens);
    const plan = await provider.planScan({});
    expect(plan.chapters.map((c) => c.chapterUsfm)).toEqual(["JHN.1", "JHN.2", "JHN.3"]);
  });

  it("restricts to the Old Testament", async () => {
    const { provider, tokens } = makeProvider(base, { scope: "old_testament" });
    await connect(tokens);
    const plan = await provider.planScan({});
    expect(plan.chapters.map((c) => c.chapterUsfm)).toEqual(["GEN.1"]);
  });

  it("restricts to selected books", async () => {
    const { provider, tokens } = makeProvider(base, { scope: "books", books: ["gen"] });
    await connect(tokens);
    const plan = await provider.planScan({});
    expect(plan.chapters.map((c) => c.chapterUsfm)).toEqual(["GEN.1"]);
  });

  it("produces a fingerprint that changes with the scope", async () => {
    const a = makeProvider(base, { scope: "whole" });
    await connect(a.tokens);
    const b = makeProvider(base, { scope: "new_testament" });
    await connect(b.tokens);

    const fpA = (await a.provider.planScan({})).fingerprint;
    const fpB = (await b.provider.planScan({})).fingerprint;
    expect(fpA).not.toBe(fpB);
  });

  it("produces a stable fingerprint for the same scope", async () => {
    const a = makeProvider(base);
    await connect(a.tokens);
    const first = (await a.provider.planScan({})).fingerprint;
    const second = (await a.provider.planScan({})).fingerprint;
    expect(first).toBe(second);
  });
});

describe("fetching highlights", () => {
  it("maps the documented response into domain items", async () => {
    const { provider, tokens } = makeProvider([
      ...base,
      { match: /\/v1\/highlights\?/, body: CHAPTER_JHN3 },
    ]);
    await connect(tokens);

    const items = await provider.fetchChapterHighlights(
      { chapterUsfm: "JHN.3", bibleId: 3034 },
      {},
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      id: "3034:JHN.3.16",
      usfm: "JHN.3.16",
      reference: "John 3:16",
      bibleId: 3034,
      bibleVersion: "BSB",
      color: "44aa44",
      canonicalUrl: "https://www.bible.com/bible/3034/JHN.3.16",
    });
    // No verse text unless explicitly enabled.
    expect(items[0]?.verseText).toBeUndefined();
  });

  it("sends the app key and bearer token, and queries by chapter", async () => {
    const { provider, tokens, requests } = makeProvider([
      ...base,
      { match: /\/v1\/highlights\?/, body: CHAPTER_JHN3 },
    ]);
    await connect(tokens);
    await provider.fetchChapterHighlights({ chapterUsfm: "JHN.3", bibleId: 3034 }, {});

    const call = requests.find((r) => r.url.includes("/v1/highlights"));
    expect(call?.headers?.["X-YVP-App-Key"]).toBe("test-app-key");
    expect(call?.headers?.Authorization).toBe("Bearer access-token-value");
    expect(call?.url).toContain("bible_id=3034");
    expect(call?.url).toContain("passage_id=JHN.3");
  });

  it("treats 204 as an empty chapter, not an error", async () => {
    const { provider, tokens } = makeProvider([
      ...base,
      { match: /\/v1\/highlights\?/, status: 204 },
    ]);
    await connect(tokens);
    await expect(
      provider.fetchChapterHighlights({ chapterUsfm: "JHN.1", bibleId: 3034 }, {}),
    ).resolves.toEqual([]);
  });

  it("rejects a response that does not match the documented schema", async () => {
    const { provider, tokens } = makeProvider([
      ...base,
      { match: /\/v1\/highlights\?/, body: CORRUPT_HIGHLIGHTS },
    ]);
    await connect(tokens);
    await expect(
      provider.fetchChapterHighlights({ chapterUsfm: "JHN.3", bibleId: 3034 }, {}),
    ).rejects.toThrow(/did not match the documented schema/);
  });

  it("rejects a malformed JSON body", async () => {
    const http = new ResilientHttp({
      transport: async (req) =>
        req.url.includes("/v1/highlights")
          ? { status: 200, headers: {}, text: "{not json" }
          : { status: 200, headers: {}, text: JSON.stringify(BIBLE_INDEX) },
      policy: { ...DEFAULT_RETRY_POLICY, minIntervalMs: 0, maxAttempts: 1 },
      sleepFn: async () => undefined,
    });
    const tokens = new TokenStore({
      persistence: "session",
      save: async () => undefined,
      load: async () => null,
    });
    await connect(tokens);
    const provider = new OfficialApiProvider({
      http,
      oauth: {} as OAuthClient,
      tokens,
      appKey: "k",
      bibleId: 3034,
      scanScope: { scope: "whole", books: [] },
      downloadVerseText: false,
    });
    await expect(
      provider.fetchChapterHighlights({ chapterUsfm: "JHN.3", bibleId: 3034 }, {}),
    ).rejects.toThrow(/malformed JSON/);
  });

  it("ignores entries belonging to a different Bible version", async () => {
    const { provider, tokens } = makeProvider([
      ...base,
      {
        match: /\/v1\/highlights\?/,
        body: { data: [{ bible_id: 111, passage_id: "JHN.3.16", color: "44aa44" }] },
      },
    ]);
    await connect(tokens);
    await expect(
      provider.fetchChapterHighlights({ chapterUsfm: "JHN.3", bibleId: 3034 }, {}),
    ).resolves.toEqual([]);
  });
});

describe("verse text", () => {
  it("fetches and attaches verse text with its copyright when enabled", async () => {
    const { provider, tokens } = makeProvider(
      [
        ...base,
        {
          match: /\/v1\/highlights\?/,
          body: { data: [{ bible_id: 3034, passage_id: "JHN.3.16", color: "44aa44" }] },
        },
        { match: /\/passages\//, body: { content: "For God so loved the world" } },
      ],
      { downloadVerseText: true },
    );
    await connect(tokens);
    const items = await provider.fetchChapterHighlights(
      { chapterUsfm: "JHN.3", bibleId: 3034 },
      {},
    );
    expect(items[0]?.verseText).toBe("For God so loved the world");
    expect(items[0]?.copyright).toContain("public domain");
  });

  it("degrades gracefully when the passage endpoint fails", async () => {
    const { provider, tokens } = makeProvider(
      [
        ...base,
        {
          match: /\/v1\/highlights\?/,
          body: { data: [{ bible_id: 3034, passage_id: "JHN.3.16", color: "44aa44" }] },
        },
        { match: /\/passages\//, status: 403, body: { message: "not licensed" } },
      ],
      { downloadVerseText: true },
    );
    await connect(tokens);
    const items = await provider.fetchChapterHighlights(
      { chapterUsfm: "JHN.3", bibleId: 3034 },
      {},
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.verseText).toBeUndefined();
    expect(items[0]?.copyright).toBeUndefined();
  });

  it("caches verse text within a run", async () => {
    const { provider, tokens, requests } = makeProvider(
      [
        ...base,
        {
          match: /\/v1\/highlights\?/,
          body: { data: [{ bible_id: 3034, passage_id: "JHN.3.16", color: "44aa44" }] },
        },
        { match: /\/passages\//, body: { content: "text" } },
      ],
      { downloadVerseText: true },
    );
    await connect(tokens);
    await provider.fetchChapterHighlights({ chapterUsfm: "JHN.3", bibleId: 3034 }, {});
    await provider.fetchChapterHighlights({ chapterUsfm: "JHN.3", bibleId: 3034 }, {});
    expect(requests.filter((r) => r.url.includes("/passages/"))).toHaveLength(1);
  });
});

describe("pagination", () => {
  /**
   * The highlights endpoint returns next_page_token - YouVersion's own SDK
   * reads it, though the published OpenAPI omits it. Ignoring it silently
   * dropped rows from any densely highlighted chapter.
   */
  function pagedProvider(pages: Array<{ data: unknown[]; next_page_token?: string | null }>) {
    const urls: string[] = [];
    let call = 0;
    const http = new ResilientHttp({
      transport: async (req) => {
        urls.push(req.url);
        if (req.url.includes("/index")) {
          return { status: 200, headers: {}, text: JSON.stringify(BIBLE_INDEX) };
        }
        if (/\/v1\/bibles\/3034$/.test(req.url)) {
          return { status: 200, headers: {}, text: JSON.stringify(BIBLE_META) };
        }
        const page = pages[Math.min(call++, pages.length - 1)];
        return { status: 200, headers: {}, text: JSON.stringify(page) };
      },
      policy: { ...DEFAULT_RETRY_POLICY, minIntervalMs: 0, maxAttempts: 1 },
      sleepFn: async () => undefined,
    });
    const tokens = new TokenStore({
      persistence: "session",
      save: async () => undefined,
      load: async () => null,
    });
    const provider = new OfficialApiProvider({
      http,
      oauth: {} as never,
      tokens,
      appKey: "k",
      bibleId: 3034,
      scanScope: { scope: "whole", books: [] },
      downloadVerseText: false,
    });
    return { provider, tokens, urls };
  }

  it("follows next_page_token and returns every row", async () => {
    const { provider, tokens, urls } = pagedProvider([
      {
        data: [{ bible_id: 3034, passage_id: "JHN.3.16", color: "44aa44" }],
        next_page_token: "p2",
      },
      {
        data: [{ bible_id: 3034, passage_id: "JHN.3.17", color: "ffdd00" }],
        next_page_token: null,
      },
    ]);
    await connect(tokens);

    const items = await provider.fetchChapterHighlights(
      { chapterUsfm: "JHN.3", bibleId: 3034 },
      {},
    );
    expect(items.map((i) => i.usfm)).toEqual(["JHN.3.16", "JHN.3.17"]);
    expect(urls.some((u) => u.includes("page_token=p2"))).toBe(true);
  });

  it("stops after one page when there is no token", async () => {
    const { provider, tokens, urls } = pagedProvider([
      { data: [{ bible_id: 3034, passage_id: "JHN.3.16", color: "44aa44" }] },
    ]);
    await connect(tokens);
    await provider.fetchChapterHighlights({ chapterUsfm: "JHN.3", bibleId: 3034 }, {});
    expect(urls.filter((u) => u.includes("/v1/highlights"))).toHaveLength(1);
  });

  it("does not spin forever if the server keeps returning the same token", async () => {
    const { provider, tokens, urls } = pagedProvider([
      {
        data: [{ bible_id: 3034, passage_id: "JHN.3.16", color: "44aa44" }],
        next_page_token: "loop",
      },
    ]);
    await connect(tokens);
    const items = await provider.fetchChapterHighlights(
      { chapterUsfm: "JHN.3", bibleId: 3034 },
      {},
    );
    expect(urls.filter((u) => u.includes("/v1/highlights")).length).toBeLessThanOrEqual(20);
    expect(items.length).toBeGreaterThan(0);
  });
});
