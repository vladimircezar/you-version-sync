/**
 * JWT verification tests. A real RSA keypair is generated per run with Web
 * Crypto and used to sign tokens, so the verification path is exercised end to
 * end rather than mocked.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { Jwks, decodeJwt, verifyJwt } from "../src/auth/jwt";

const ISSUER = "https://api.youversion.com";
const AUDIENCE = "test-app-key";

let keyPair: CryptoKeyPair;
let jwks: Jwks;
let otherJwks: Jwks;

function b64url(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function exportJwks(pair: CryptoKeyPair, kid: string): Promise<Jwks> {
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { keys: [{ kty: "RSA", kid, alg: "RS256", use: "sig", n: jwk.n, e: jwk.e }] };
}

async function sign(
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
): Promise<string> {
  const signingInput = `${b64url(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT", ...header }))}.${b64url(
    JSON.stringify(claims),
  )}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keyPair.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${b64url(new Uint8Array(signature))}`;
}

function validClaims(overrides: Record<string, unknown> = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: "user-uuid",
    yvp_id: "user-uuid",
    name: "Test User",
    exp: nowSec + 3600,
    iat: nowSec,
    nonce: "nonce-value",
    ...overrides,
  };
}

beforeAll(async () => {
  const algorithm = {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  };
  keyPair = (await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"])) as CryptoKeyPair;
  jwks = await exportJwks(keyPair, "k1");
  const other = (await crypto.subtle.generateKey(algorithm, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  otherJwks = await exportJwks(other, "k1");
});

describe("decoding", () => {
  it("reads header and claims without verifying", async () => {
    const token = await sign(validClaims());
    const decoded = decodeJwt(token);
    expect(decoded.header.alg).toBe("RS256");
    expect(decoded.claims.yvp_id).toBe("user-uuid");
  });

  it("rejects a malformed token", () => {
    expect(() => decodeJwt("not.a")).toThrow(/three segments/);
    expect(() => decodeJwt("aaa.bbb.ccc")).toThrow(/valid JSON/);
  });
});

describe("verification", () => {
  it("accepts a correctly signed token", async () => {
    const claims = await verifyJwt(await sign(validClaims()), {
      jwks,
      issuer: ISSUER,
      audience: AUDIENCE,
      nonce: "nonce-value",
    });
    expect(claims.name).toBe("Test User");
  });

  it("rejects a token signed by a different key", async () => {
    await expect(
      verifyJwt(await sign(validClaims()), { jwks: otherJwks, issuer: ISSUER, audience: AUDIENCE }),
    ).rejects.toThrow(/signature verification failed/);
  });

  it("rejects a tampered payload", async () => {
    const token = await sign(validClaims());
    const [h, , s] = token.split(".");
    const forged = `${h}.${b64url(JSON.stringify(validClaims({ name: "Someone Else" })))}.${s}`;
    await expect(verifyJwt(forged, { jwks, issuer: ISSUER, audience: AUDIENCE })).rejects.toThrow(
      /signature verification failed/,
    );
  });

  it("rejects algorithms outside the allow-list, including none", async () => {
    const token = await sign(validClaims(), { alg: "none" });
    await expect(verifyJwt(token, { jwks, issuer: ISSUER, audience: AUDIENCE })).rejects.toThrow(
      /unsupported algorithm/,
    );
    const hs = await sign(validClaims(), { alg: "HS256" });
    await expect(verifyJwt(hs, { jwks, issuer: ISSUER, audience: AUDIENCE })).rejects.toThrow(
      /unsupported algorithm/,
    );
  });

  it("rejects the wrong issuer", async () => {
    await expect(
      verifyJwt(await sign(validClaims({ iss: "https://evil.example" })), {
        jwks,
        issuer: ISSUER,
        audience: AUDIENCE,
      }),
    ).rejects.toThrow(/unexpected issuer/);
  });

  it("rejects the wrong audience", async () => {
    await expect(
      verifyJwt(await sign(validClaims({ aud: "another-app" })), {
        jwks,
        issuer: ISSUER,
        audience: AUDIENCE,
      }),
    ).rejects.toThrow(/unexpected audience/);
  });

  it("rejects an expired token", async () => {
    const past = Math.floor(Date.now() / 1000) - 7200;
    await expect(
      verifyJwt(await sign(validClaims({ exp: past })), {
        jwks,
        issuer: ISSUER,
        audience: AUDIENCE,
      }),
    ).rejects.toThrow(/expired/);
  });

  it("rejects a nonce mismatch", async () => {
    await expect(
      verifyJwt(await sign(validClaims()), {
        jwks,
        issuer: ISSUER,
        audience: AUDIENCE,
        nonce: "different",
      }),
    ).rejects.toThrow(/nonce mismatch/);
  });

  it("rejects when the JWKS has no usable key", async () => {
    await expect(
      verifyJwt(await sign(validClaims()), {
        jwks: { keys: [] },
        issuer: ISSUER,
        audience: AUDIENCE,
      }),
    ).rejects.toThrow(/no matching key/);
  });
});
