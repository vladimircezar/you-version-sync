import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotConnectedError, PersistedTokens, TokenStore } from "../src/auth/tokenStore";
import type { OAuthClient, TokenSet } from "../src/auth/oauth";

function makeTokens(overrides: Partial<TokenSet> = {}): TokenSet {
  return {
    accessToken: "access-1",
    refreshToken: "refresh-1",
    expiresAt: Date.now() + 3_600_000,
    grantedPermissions: ["highlights"],
    ...overrides,
  };
}

function makeStore(persistence: "disk" | "session" = "disk", now = () => Date.now()) {
  let saved: PersistedTokens | null = null;
  const save = vi.fn(async (payload: PersistedTokens | null) => {
    saved = payload;
  });
  const store = new TokenStore({
    persistence,
    now,
    save,
    load: async () => saved,
  });
  return { store, save, read: () => saved };
}

/** A refresh client that hands out a new access token each call. */
function fakeClient(): { client: OAuthClient; calls: () => number } {
  let calls = 0;
  const client = {
    refresh: async (refreshToken: string, granted: string[]): Promise<TokenSet> => {
      calls += 1;
      // Simulate a small delay so concurrent callers overlap.
      await new Promise((r) => setTimeout(r, 5));
      return {
        accessToken: `access-${calls + 1}`,
        refreshToken,
        expiresAt: Date.now() + 3_600_000,
        grantedPermissions: granted,
      };
    },
  } as unknown as OAuthClient;
  return { client, calls: () => calls };
}

describe("connection state", () => {
  it("starts disconnected", () => {
    const { store } = makeStore();
    expect(store.isConnected()).toBe(false);
    expect(store.grantedPermissions()).toEqual([]);
    expect(store.expiresAtIso()).toBeNull();
  });

  it("reports granted permissions once connected", async () => {
    const { store } = makeStore();
    await store.store(makeTokens());
    expect(store.isConnected()).toBe(true);
    expect(store.hasPermission("highlights")).toBe(true);
    expect(store.hasPermission("notes")).toBe(false);
  });
});

describe("persistence", () => {
  it("writes tokens to plugin data under disk persistence", async () => {
    const { store, read } = makeStore("disk");
    await store.store(makeTokens());
    expect(read()?.tokens?.accessToken).toBe("access-1");
  });

  it("never writes tokens under session persistence", async () => {
    const { store, read } = makeStore("session");
    await store.store(makeTokens());
    expect(read()).toBeNull();
    expect(store.isConnected()).toBe(true);
  });

  it("does not restore anything on hydrate under session persistence", async () => {
    const { store } = makeStore("session");
    await store.hydrate();
    expect(store.isConnected()).toBe(false);
  });

  it("clears both memory and disk on disconnect", async () => {
    const { store, read } = makeStore("disk");
    await store.store(makeTokens());
    await store.clear();
    expect(store.isConnected()).toBe(false);
    expect(read()).toBeNull();
  });
});

describe("expiry and refresh", () => {
  let clock = 1_000_000;

  beforeEach(() => {
    clock = 1_000_000;
  });

  it("treats a token inside the skew window as expired", async () => {
    const { store } = makeStore("disk", () => clock);
    await store.store(makeTokens({ expiresAt: clock + 30_000 }));
    expect(store.isExpired()).toBe(true);
  });

  it("returns the current token when it is still valid", async () => {
    const { store } = makeStore("disk", () => clock);
    await store.store(makeTokens({ expiresAt: clock + 3_600_000 }));
    const { client } = fakeClient();
    await expect(store.getAccessToken(client)).resolves.toBe("access-1");
  });

  it("refreshes an expired token", async () => {
    const { store } = makeStore("disk", () => clock);
    await store.store(makeTokens({ expiresAt: clock - 1 }));
    const { client, calls } = fakeClient();
    await expect(store.getAccessToken(client)).resolves.toBe("access-2");
    expect(calls()).toBe(1);
  });

  it("shares a single refresh between concurrent callers", async () => {
    const { store } = makeStore("disk", () => clock);
    await store.store(makeTokens({ expiresAt: clock - 1 }));
    const { client, calls } = fakeClient();

    const results = await Promise.all([
      store.getAccessToken(client),
      store.getAccessToken(client),
      store.getAccessToken(client),
    ]);

    expect(calls()).toBe(1);
    expect(new Set(results).size).toBe(1);
  });

  it("throws when there is nothing to refresh with", async () => {
    const { store } = makeStore("disk", () => clock);
    await store.store(makeTokens({ expiresAt: clock - 1, refreshToken: undefined }));
    const { client } = fakeClient();
    await expect(store.getAccessToken(client)).rejects.toBeInstanceOf(NotConnectedError);
  });

  it("throws when not connected at all", async () => {
    const { store } = makeStore();
    const { client } = fakeClient();
    await expect(store.getAccessToken(client)).rejects.toBeInstanceOf(NotConnectedError);
  });

  it("forces a refresh after invalidateAccessToken", async () => {
    const { store } = makeStore("disk", () => clock);
    await store.store(makeTokens({ expiresAt: clock + 3_600_000 }));
    store.invalidateAccessToken();
    expect(store.isExpired()).toBe(true);
    const { client, calls } = fakeClient();
    await store.getAccessToken(client);
    expect(calls()).toBe(1);
  });
});
