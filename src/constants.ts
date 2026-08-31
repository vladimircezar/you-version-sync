/** Endpoints and fixed values from the YouVersion Platform docs. See docs/api-research.md. */

export const API_BASE = "https://api.youversion.com";

export const AUTH_ENDPOINTS = {
  /** Hop 1: user consent. */
  authorize: `${API_BASE}/auth/authorize`,
  /** Hop 2: replay `state` alone; server mints the authorization code. */
  callback: `${API_BASE}/auth/callback`,
  /** Hop 3: exchange code (or refresh token) for tokens. */
  token: `${API_BASE}/auth/token`,
  jwks: `${API_BASE}/.well-known/jwks.json`,
  issuer: API_BASE,
} as const;

/**
 * The only OAuth scopes the authorization endpoint accepts. Since July 2026 an
 * unsupported value is rejected with `400 invalid_scope` rather than ignored.
 */
export const SUPPORTED_SCOPES = ["openid", "profile", "email"] as const;

/**
 * The only user-data permission YouVersion exposes. This is NOT an OAuth scope
 * and must never be sent as one; it travels in `requested_permissions[]`.
 */
export const HIGHLIGHTS_PERMISSION = "highlights";

export const MANAGED_START = "<!-- youversion-sync:managed:start -->";
export const MANAGED_END = "<!-- youversion-sync:managed:end -->";
export const USER_START = "<!-- youversion-sync:user:start -->";
export const USER_END = "<!-- youversion-sync:user:end -->";

export const PLUGIN_ID = "youversion-sync";

/** Minimum automatic sync interval. A chapter scan is many requests; do not hammer. */
export const MIN_AUTO_SYNC_MINUTES = 60;

export function bibleComUrl(bibleId: number, usfm: string): string {
  return `https://www.bible.com/bible/${bibleId}/${usfm}`;
}

/** Human-readable name for a scan scope, for notices and generated notes. */
export function scanScopeLabel(scope: string, books: readonly string[] = []): string {
  switch (scope) {
    case "whole":
      return "the whole Bible";
    case "new_testament":
      return "the New Testament only";
    case "old_testament":
      return "the Old Testament only";
    case "books":
      return books.length > 0 ? `these books only: ${books.join(", ")}` : "no books selected";
    default:
      return scope;
  }
}
