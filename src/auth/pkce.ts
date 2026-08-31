/**
 * PKCE (RFC 7636) and OAuth nonce/state generation.
 *
 * Uses Web Crypto, which is present both in Obsidian's Electron renderer and in
 * Node 20+ (so tests exercise the same code path as production).
 */

const VERIFIER_BYTES = 32; // → 43 base64url chars, the RFC 7636 minimum length.

function getCrypto(): Crypto {
  const c = globalThis.crypto;
  if (!c?.subtle || typeof c.getRandomValues !== "function") {
    throw new Error("Web Crypto is unavailable; cannot perform a secure OAuth flow.");
  }
  return c;
}

export function base64UrlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  // btoa exists in Electron; Node 20+ provides it globally too.
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  getCrypto().getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/**
 * A fresh `code_verifier`. Must never be reused across authorization attempts —
 * callers get a new one per flow and discard it after the token exchange.
 */
export function generateCodeVerifier(): string {
  return randomBase64Url(VERIFIER_BYTES);
}

/** `code_challenge` = BASE64URL(SHA256(ASCII(code_verifier))), i.e. method S256. */
export async function computeCodeChallenge(verifier: string): Promise<string> {
  const digest = await getCrypto().subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(digest);
}

/** CSRF token for the authorization request. Also the key for the two-hop replay. */
export function generateState(): string {
  return randomBase64Url(16);
}

/** OIDC replay-protection nonce; echoed back in the id_token. */
export function generateNonce(): string {
  return randomBase64Url(16);
}

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: "S256";
}

export async function createPkcePair(): Promise<PkcePair> {
  const verifier = generateCodeVerifier();
  return { verifier, challenge: await computeCodeChallenge(verifier), method: "S256" };
}

/**
 * Constant-time-ish string comparison for `state` validation. Length is allowed
 * to leak; the values are single-use and short-lived.
 */
export function safeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
