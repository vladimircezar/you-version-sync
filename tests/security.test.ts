import { describe, expect, it } from "vitest";
import {
  REDACTED,
  redactError,
  redactHeaders,
  redactString,
  redactUrl,
  summarizeContent,
} from "../src/security/redact";

const JWT =
  "eyJhbGciOiJSUzI1NiIsImtpZCI6ImsxIn0.eyJzdWIiOiIxMjMiLCJlbWFpbCI6ImFAYi5jb20ifQ.c2lnbmF0dXJlLWJ5dGVz";

describe("token redaction", () => {
  it("removes JWTs wherever they appear", () => {
    expect(redactString(`token is ${JWT} ok`)).toBe(`token is ${REDACTED} ok`);
  });

  it("removes bearer headers", () => {
    expect(redactString(`Authorization: Bearer ${JWT}`)).not.toContain("eyJ");
  });

  it("removes keyed secrets in json and query form", () => {
    expect(redactString('{"access_token":"abc123","x":1}')).toContain(REDACTED);
    expect(redactString('{"access_token":"abc123"}')).not.toContain("abc123");
    expect(redactString("code_verifier=xyz987&other=1")).not.toContain("xyz987");
    expect(redactString("refresh_token: rrr")).not.toContain("rrr");
  });

  it("removes email addresses", () => {
    expect(redactString("contact person@example.com now")).toBe(`contact ${REDACTED} now`);
  });

  it("leaves harmless strings untouched", () => {
    expect(redactString("scanned JHN.3 successfully")).toBe("scanned JHN.3 successfully");
  });
});

describe("URL redaction", () => {
  it("keeps the path but hides sensitive query values", () => {
    const out = redactUrl("https://api.youversion.com/auth/token?code=SECRET&state=abc&nonce=def");
    expect(out).toContain("api.youversion.com/auth/token");
    expect(out).not.toContain("SECRET");
    expect(out).not.toContain("abc");
    expect(out).not.toContain("def");
  });

  it("preserves non-sensitive query values that aid debugging", () => {
    const out = redactUrl(
      "https://api.youversion.com/v1/highlights?bible_id=3034&passage_id=JHN.3",
    );
    expect(out).toContain("bible_id=3034");
    expect(out).toContain("passage_id=JHN.3");
  });

  it("falls back to string redaction for a malformed URL", () => {
    expect(redactUrl("not a url access_token=zzz")).not.toContain("zzz");
  });
});

describe("header redaction", () => {
  it("hides credential headers and keeps the rest", () => {
    const out = redactHeaders({
      Authorization: `Bearer ${JWT}`,
      "X-YVP-App-Key": "app-key-value",
      Cookie: "session=1",
      Accept: "application/json",
    });
    expect(out.Authorization).toBe(REDACTED);
    expect(out["X-YVP-App-Key"]).toBe(REDACTED);
    expect(out.Cookie).toBe(REDACTED);
    expect(out.Accept).toBe("application/json");
  });
});

describe("error redaction", () => {
  it("strips secrets out of thrown errors", () => {
    expect(redactError(new Error(`failed with access_token=${JWT}`))).not.toContain("eyJ");
  });

  it("handles non-Error values", () => {
    expect(redactError("plain string")).toBe("plain string");
    expect(redactError(undefined)).toBe("Unknown error");
  });

  it("truncates very long messages", () => {
    expect(redactError(new Error("x".repeat(1000))).length).toBeLessThanOrEqual(300);
  });
});

describe("content summarisation", () => {
  it("reports size without revealing scripture or note text", () => {
    expect(summarizeContent("For God so loved the world")).toBe("(26 chars, withheld)");
    expect(summarizeContent(undefined)).toBe("(none)");
  });
});
