import { describe, expect, it } from "vitest";
import {
  base64UrlEncode,
  computeCodeChallenge,
  createPkcePair,
  generateCodeVerifier,
  generateNonce,
  generateState,
  safeEquals,
} from "../src/auth/pkce";

describe("PKCE generation", () => {
  it("produces a verifier within the RFC 7636 length range", () => {
    const verifier = generateCodeVerifier();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
  });

  it("produces base64url output with no padding or unsafe characters", () => {
    expect(generateCodeVerifier()).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(base64UrlEncode(new Uint8Array([255, 254, 253]))).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("never repeats a verifier", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateCodeVerifier()));
    expect(seen.size).toBe(200);
  });

  it("computes the S256 challenge from the RFC 7636 test vector", async () => {
    // RFC 7636 Appendix B.
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    await expect(computeCodeChallenge(verifier)).resolves.toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("returns a matching verifier/challenge pair", async () => {
    const pair = await createPkcePair();
    expect(pair.method).toBe("S256");
    await expect(computeCodeChallenge(pair.verifier)).resolves.toBe(pair.challenge);
  });
});

describe("state and nonce", () => {
  it("generates distinct values each time", () => {
    expect(generateState()).not.toBe(generateState());
    expect(generateNonce()).not.toBe(generateNonce());
  });
});

describe("state comparison", () => {
  it("accepts an exact match and rejects everything else", () => {
    expect(safeEquals("abc123", "abc123")).toBe(true);
    expect(safeEquals("abc123", "abc124")).toBe(false);
    expect(safeEquals("abc", "abcd")).toBe(false);
    expect(safeEquals("", "")).toBe(true);
  });
});
