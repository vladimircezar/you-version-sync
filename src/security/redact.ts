/**
 * Redaction helpers.
 *
 * Everything that could reach a log line, a diagnostics report or an error
 * surfaced to the user passes through here first. The rules are deliberately
 * conservative: it is better to over-redact a harmless string than to leak one
 * token. See docs/privacy-and-security.md.
 */

export const REDACTED = "[redacted]";

/** Header names whose values must never be rendered, in any casing. */
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-yvp-app-key",
  "proxy-authorization",
]);

/**
 * Query/body keys whose values must never be rendered. Matched case-insensitively
 * against the whole key, and also as a substring for `*token*`-style names.
 */
const SENSITIVE_KEYS = [
  "access_token",
  "refresh_token",
  "id_token",
  "code",
  "code_verifier",
  "code_challenge",
  "client_secret",
  "app_key",
  "token",
  "password",
  "authorization",
  "email",
];

/** JWTs: three base64url segments. Matched before the generic long-secret rule. */
const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;
const BEARER_RE = /\b(Bearer)\s+[A-Za-z0-9._~+/-]+=*/gi;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/** `key=value` / `key: value` / `"key":"value"` pairs for any sensitive key. */
const KEYED_VALUE_RE = new RegExp(
  String.raw`(["']?\b(?:${SENSITIVE_KEYS.join("|")})\b["']?\s*[:=]\s*)(["']?)([^"'\s,;&}]+)\2`,
  "gi",
);

/**
 * Scrub a free-form string. Safe to call on anything, including strings that
 * contain no secrets — it is a no-op in that case.
 */
export function redactString(input: string): string {
  return input
    .replace(JWT_RE, REDACTED)
    .replace(BEARER_RE, `$1 ${REDACTED}`)
    .replace(
      KEYED_VALUE_RE,
      (_m, prefix: string, quote: string) => `${prefix}${quote}${REDACTED}${quote}`,
    )
    .replace(EMAIL_RE, REDACTED);
}

/** Scrub a URL: keeps origin and path, redacts sensitive query values. */
export function redactUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return redactString(raw);
  }
  for (const key of Array.from(url.searchParams.keys())) {
    if (isSensitiveKey(key)) url.searchParams.set(key, REDACTED);
  }
  // `state` and `nonce` are not secrets, but they are per-session correlators;
  // there is no diagnostic value in printing them.
  for (const key of ["state", "nonce"]) {
    if (url.searchParams.has(key)) url.searchParams.set(key, REDACTED);
  }
  return url.toString();
}

export function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase();
  return SENSITIVE_KEYS.some((s) => k === s || k.includes("token") || k.includes("secret"));
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? REDACTED : redactString(v);
  }
  return out;
}

/**
 * Turn an unknown thrown value into a short, redacted, user-safe message.
 * Stack traces are dropped: they can embed URLs with query strings.
 */
export function redactError(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "Unknown error";
  return truncate(redactString(raw), 300);
}

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * Scripture text and highlight content are user data. Diagnostics may report
 * *that* an item exists and its reference, never what it says.
 */
export function summarizeContent(content: string | undefined): string {
  if (!content) return "(none)";
  return `(${content.length} chars, withheld)`;
}
