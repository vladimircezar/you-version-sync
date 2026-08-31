# Privacy and security

## The short version

- The plugin talks to exactly one host: `api.youversion.com`.
- It never asks for, sees, or stores your YouVersion password.
- It never writes tokens into your vault.
- There is no telemetry of any kind.
- It only reads from YouVersion. It cannot change or delete anything in your account.

## Token storage, stated plainly

**Obsidian provides no OS keychain or secret-storage API to community plugins.** There is no
`app.secrets`, no keytar binding, nothing. Every Obsidian plugin that holds a credential faces
this, and pretending otherwise would be worse than saying it.

So here is exactly what happens.

Tokens are written to the plugin's own `data.json`, at
`<vault>/.obsidian/plugins/youversion-sync/data.json`, **in plain text**. That file is:

- outside the Markdown tree you read and edit,
- never written to by the sync engine's Markdown layer, and
- readable by anything that can read your vault directory.

That last point is the real one. If your `.obsidian` folder is synced to a third-party service, or
your disk is unencrypted and the machine is shared, your refresh token is exposed the same way any
other file is.

### What is deliberately *not* done

The tokens are **not** encrypted at rest with a key stored next to them. That pattern is common and
it is theatre: an attacker who can read `data.json` can read the sibling key. It would make the
plugin look safer without making it safer, so it is not done.

### What you can do about it

| Option | Effect | Cost |
| --- | --- | --- |
| **Token storage: Session only** | Tokens live in memory and are never written to disk | Reconnect after every Obsidian restart |
| Full-disk encryption | The usual protection for data at rest | None, if already on |
| Exclude `.obsidian/plugins/youversion-sync/` from third-party sync | Keeps the token off other devices and servers | Settings do not sync |
| Disconnect when finished | Clears tokens from memory and disk | Reconnect to sync again |

The setting is under **Settings → YouVersion Sync → YouVersion application → Token storage**.

### Revoking access

"Disconnect account" discards the plugin's copy of your tokens. YouVersion publishes no token
revocation endpoint (see open question 2 in `docs/api-research.md`), so to revoke the app's access
*server-side*, remove it from your YouVersion account's connected-apps settings.

## What is never logged

Redaction is centralised in `src/security/redact.ts`, and every path to the console or to a
diagnostics report goes through it. The following are removed:

- JWTs (any `eyJ…` three-segment token)
- `Authorization` / `Bearer` values, cookies, `X-YVP-App-Key`
- `access_token`, `refresh_token`, `id_token`, `code`, `code_verifier`, `code_challenge`,
  `client_secret`, and anything whose key contains `token` or `secret`
- email addresses
- `state` and `nonce` (not secrets, but useless correlators in a log)

Additionally, **API response bodies are never echoed verbatim**. HTTP errors are rendered from the
status code plus, at most, a short `message` field from a JSON body; a non-JSON error body is
discarded entirely rather than risking HTML or PII in a log line.

Scripture text and highlight content never appear in logs or diagnostics. Where a size is useful,
it is reported as `(N chars, withheld)`.

The diagnostics report is passed through the redactor once more on its way out, so a future edit
to the report builder cannot silently introduce a leak.

## What the sanitized diagnostics report contains

Plugin version, Obsidian version, platform, provider, connection *state* (never a token), granted
permissions, token storage mode, access-token expiry timestamp, whether an App Key is configured,
last sync time, counts of created/updated/unchanged/conflicted/failed, HTTP status-code counts,
redacted request URLs, redacted messages, and the capability matrix.

It contains no tokens, no cookies, no authorization headers, no email address, no note content and
no highlight text.

## Network behaviour

Requests go through Obsidian's `requestUrl` rather than `fetch`. That avoids the renderer's CORS
restrictions and does not attach vault cookies. Every request carries:

- `X-YVP-App-Key` — identifies the *application*, not you
- `Authorization: Bearer <access_token>` — for endpoints that read your data

The only host contacted is `api.youversion.com`. You can verify this yourself in the built bundle:

```bash
grep -oE 'https://[a-z0-9.-]+\.[a-z]+' main.js | sort -u
```

## OAuth security properties

- **PKCE (S256) on every flow.** A fresh 32-byte verifier per attempt, never reused, never
  persisted, discarded after the exchange. It is never sent to `/auth/authorize`.
- **`state` validated on every hop**, including the error and code redirects. A mismatch aborts the
  flow before anything else is examined.
- **`nonce` checked** against the `id_token`.
- **JWT signatures verified** against `https://api.youversion.com/.well-known/jwks.json`, with an
  allow-list restricted to RS256 — `none` and HMAC algorithms are rejected — plus `iss`, `aud` and
  `exp` checks. `tests/jwt.test.ts` signs real tokens with a generated RSA keypair and asserts that
  tampering, wrong keys, wrong issuer, wrong audience, expiry and `alg` substitution are all
  rejected.
- **Public client.** No client secret is sent, because a client secret shipped in a plugin is not a
  secret.
- **Loopback listener bound to `127.0.0.1`**, closed in a `finally`, five-minute timeout.
- **Minimum scopes.** `openid profile email` for identity; `highlights` as the only requested data
  permission. The email claim is read and then discarded — only a display name is stored.

## Things this plugin will not do

Not "has not got around to" — will not:

- Ask for your YouVersion password, or handle one
- Scrape the web app, extract cookies, automate login, or bypass a CAPTCHA
- Use undocumented or private endpoints
- Write, modify or delete anything in your YouVersion account
- Send telemetry or analytics
- Upload your vault, your notes, or any export file anywhere
- Delete your notes during a sync

An experimental connector using undocumented access is out of scope by design. The placeholder in
`src/providers/experimental.ts` contains no endpoints and no request code, and any real
implementation would require a separate explicit decision and a security review first.

## Scripture text and copyright

Bible translations are licensed individually, and most are not public domain. Storing verse text
in your vault is a form of local reproduction, and whether that is permitted depends on the
translation's licence and on the YouVersion Platform terms (which cover non-commercial use).

Therefore **"Download verse text" is off by default.** When you turn it on, the plugin stores the
publisher's copyright string alongside the text in every note. Only enable it for versions whose
licence you have reviewed and accepted in the Platform Portal.

## Reporting a security issue

Open an issue describing the problem *without* including tokens or personal data. Use the
"Copy sanitized diagnostics" button — that output is designed to be safe to paste in public.
