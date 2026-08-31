/**
 * Minimal JWT decode + RS256 signature verification against YouVersion's JWKS.
 *
 * The sign-in docs require verifying `access_token` / `id_token` signatures with
 * the keys from `/.well-known/jwks.json` before trusting any claim, and
 * restricting the accepted algorithms to an asymmetric allow-list. We only ever
 * read identity claims for display, but an unverified token is still untrusted
 * input, so it gets verified.
 */
import { z } from "zod";

/** Only asymmetric algorithms are accepted; `none`/HS* are rejected outright. */
const ALLOWED_ALGS = new Set(["RS256"]);

export const JwtClaimsSchema = z.object({
  iss: z.string().optional(),
  aud: z.union([z.string(), z.array(z.string())]).optional(),
  sub: z.string().optional(),
  exp: z.number().optional(),
  iat: z.number().optional(),
  nonce: z.string().optional(),
  yvp_id: z.string().optional(),
  name: z.string().optional(),
  email: z.string().optional(),
  profile_picture: z.string().optional(),
});
export type JwtClaims = z.infer<typeof JwtClaimsSchema>;

const JwkSchema = z.object({
  kty: z.string(),
  kid: z.string().optional(),
  alg: z.string().optional(),
  use: z.string().optional(),
  n: z.string().optional(),
  e: z.string().optional(),
});
export const JwksSchema = z.object({ keys: z.array(JwkSchema) });
export type Jwks = z.infer<typeof JwksSchema>;

function base64UrlToBytes(input: string): Uint8Array {
  const padded = input
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(input.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64UrlToString(input: string): string {
  return new TextDecoder().decode(base64UrlToBytes(input));
}

export interface DecodedJwt {
  header: { alg?: string; kid?: string; typ?: string };
  claims: JwtClaims;
  signingInput: string;
  signature: Uint8Array;
}

/**
 * Structural decode only — performs no verification. Never treat the result as
 * trusted; call {@link verifyJwt} first.
 */
export function decodeJwt(token: string): DecodedJwt {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed JWT: expected three segments.");
  const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string];

  let header: DecodedJwt["header"];
  let claims: JwtClaims;
  try {
    header = JSON.parse(base64UrlToString(rawHeader)) as DecodedJwt["header"];
    claims = JwtClaimsSchema.parse(JSON.parse(base64UrlToString(rawPayload)));
  } catch {
    throw new Error("Malformed JWT: header or payload is not valid JSON.");
  }

  return {
    header,
    claims,
    signingInput: `${rawHeader}.${rawPayload}`,
    signature: base64UrlToBytes(rawSignature),
  };
}

export interface VerifyOptions {
  jwks: Jwks;
  /** Expected `iss`. */
  issuer: string;
  /** Expected `aud` — the app_key / client_id. */
  audience: string;
  /** Expected `nonce`, when verifying an id_token from a flow we initiated. */
  nonce?: string;
  /** Clock skew tolerance in seconds. */
  toleranceSec?: number;
  now?: () => number;
}

/**
 * Verify signature, algorithm, issuer, audience, expiry and (optionally) nonce.
 * Throws with a short reason on any failure; returns the trusted claims.
 */
export async function verifyJwt(token: string, options: VerifyOptions): Promise<JwtClaims> {
  const decoded = decodeJwt(token);

  const alg = decoded.header.alg;
  if (!alg || !ALLOWED_ALGS.has(alg)) {
    throw new Error(`JWT rejected: unsupported algorithm "${alg ?? "none"}".`);
  }

  const candidates = options.jwks.keys.filter(
    (k) =>
      k.kty === "RSA" &&
      k.n &&
      k.e &&
      (!decoded.header.kid || !k.kid || k.kid === decoded.header.kid),
  );
  if (candidates.length === 0) throw new Error("JWT rejected: no matching key in the JWKS.");

  let signatureOk = false;
  for (const jwk of candidates) {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      decoded.signature as unknown as BufferSource,
      new TextEncoder().encode(decoded.signingInput) as unknown as BufferSource,
    );
    if (ok) {
      signatureOk = true;
      break;
    }
  }
  if (!signatureOk) throw new Error("JWT rejected: signature verification failed.");

  const { claims } = decoded;
  if (claims.iss !== options.issuer) throw new Error("JWT rejected: unexpected issuer.");

  const audiences = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
  if (!audiences.includes(options.audience)) throw new Error("JWT rejected: unexpected audience.");

  const nowSec = Math.floor((options.now?.() ?? Date.now()) / 1000);
  const tolerance = options.toleranceSec ?? 60;
  if (typeof claims.exp === "number" && claims.exp + tolerance < nowSec) {
    throw new Error("JWT rejected: token has expired.");
  }
  if (options.nonce && claims.nonce !== options.nonce) {
    throw new Error("JWT rejected: nonce mismatch.");
  }

  return claims;
}
