/**
 * Token custody.
 *
 * Obsidian exposes no OS keychain or secret-storage API to community plugins, so
 * tokens are persisted in the plugin's own `data.json` under
 * `.obsidian/plugins/youversion-sync/`. That file is outside the Markdown the
 * user reads and outside anything this plugin writes to the vault, but it is
 * plain text on disk. This is a real limitation, documented in
 * docs/privacy-and-security.md, surfaced in the settings tab, and mitigated by:
 *
 *   - keeping tokens out of the vault tree entirely,
 *   - never writing them to Markdown, logs or diagnostics,
 *   - offering "session only" storage, which keeps them in memory and requires
 *     reconnecting after each Obsidian restart,
 *   - clearing them on disconnect.
 *
 * It is deliberately NOT encrypted-at-rest with a key sitting next to the
 * ciphertext: that would look like protection without providing any.
 */
import { OAuthClient, TokenSet } from "./oauth";

export type TokenPersistence = "disk" | "session";

export interface PersistedTokens {
  version: 1;
  tokens: TokenSet | null;
}

export interface TokenStoreOptions {
  /** Writes the given payload to plugin data (never to the vault). */
  save: (payload: PersistedTokens | null) => Promise<void>;
  /** Reads previously persisted tokens, if any. */
  load: () => Promise<PersistedTokens | null>;
  persistence: TokenPersistence;
  now?: () => number;
  /** Refresh this many ms before actual expiry. */
  skewMs?: number;
}

export class NotConnectedError extends Error {
  constructor(message = "Not connected to YouVersion.") {
    super(message);
    this.name = "NotConnectedError";
  }
}

export class TokenStore {
  private tokens: TokenSet | null = null;
  private refreshInFlight: Promise<TokenSet> | null = null;
  private readonly now: () => number;
  private readonly skewMs: number;

  constructor(private options: TokenStoreOptions) {
    this.now = options.now ?? Date.now;
    this.skewMs = options.skewMs ?? 60_000;
  }

  /** Load from plugin data on startup. A no-op under `session` persistence. */
  async hydrate(): Promise<void> {
    if (this.options.persistence === "session") return;
    const payload = await this.options.load();
    this.tokens = payload?.tokens ?? null;
  }

  setPersistence(persistence: TokenPersistence): void {
    this.options = { ...this.options, persistence };
  }

  isConnected(): boolean {
    return this.tokens !== null;
  }

  /** Granted data permissions, e.g. `["highlights"]`. Empty when disconnected. */
  grantedPermissions(): string[] {
    return this.tokens ? [...this.tokens.grantedPermissions] : [];
  }

  hasPermission(permission: string): boolean {
    return this.grantedPermissions().includes(permission);
  }

  /** Expiry as an ISO string, for diagnostics. Never exposes the token itself. */
  expiresAtIso(): string | null {
    return this.tokens ? new Date(this.tokens.expiresAt).toISOString() : null;
  }

  isExpired(): boolean {
    return this.tokens ? this.tokens.expiresAt - this.skewMs <= this.now() : true;
  }

  /** The id_token, for one-time claim extraction at connect time. */
  peekIdToken(): string | undefined {
    return this.tokens?.idToken;
  }

  async store(tokens: TokenSet): Promise<void> {
    this.tokens = tokens;
    await this.persist();
  }

  /**
   * Return a usable access token, refreshing first if it is at or near expiry.
   * Concurrent callers share one refresh — a chapter scan issues many requests
   * and must not trigger a stampede of refresh calls.
   */
  async getAccessToken(client: OAuthClient): Promise<string> {
    if (!this.tokens) throw new NotConnectedError();
    if (!this.isExpired()) return this.tokens.accessToken;

    if (!this.tokens.refreshToken) {
      throw new NotConnectedError(
        "The YouVersion session expired and no refresh token is available. Reconnect your account.",
      );
    }

    if (!this.refreshInFlight) {
      const refreshToken = this.tokens.refreshToken;
      const granted = this.tokens.grantedPermissions;
      this.refreshInFlight = client
        .refresh(refreshToken, granted, this.now())
        .then(async (next) => {
          await this.store(next);
          return next;
        })
        .finally(() => {
          this.refreshInFlight = null;
        });
    }

    const refreshed = await this.refreshInFlight;
    return refreshed.accessToken;
  }

  /**
   * Mark the current access token as expired so the next `getAccessToken` call
   * refreshes it. Used when the API rejects a token we still believed valid.
   */
  invalidateAccessToken(): void {
    if (this.tokens) this.tokens = { ...this.tokens, expiresAt: 0 };
  }

  /** Forget everything, in memory and on disk. */
  async clear(): Promise<void> {
    this.tokens = null;
    this.refreshInFlight = null;
    await this.options.save(null);
  }

  private async persist(): Promise<void> {
    if (this.options.persistence === "session") {
      // Make sure nothing lingers from a previous `disk` session.
      await this.options.save(null);
      return;
    }
    await this.options.save({ version: 1, tokens: this.tokens });
  }
}
