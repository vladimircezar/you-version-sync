# Architecture

## Shape of the thing

```
main.ts                 Plugin lifecycle, commands, orchestration
settings.ts             Settings model, defaults, settings tab
constants.ts            Endpoints and fixed values from the docs

auth/                   Getting and holding an access token
  pkce.ts                 RFC 7636 verifier/challenge, state, nonce
  oauth.ts                Authorize URL, code exchange, refresh
  loopback.ts             Desktop redirect receiver (the three-hop dance)
  jwt.ts                  JWKS-backed RS256 verification
  tokenStore.ts           Custody, expiry, single-flight refresh

providers/              Where data comes from
  types.ts                The provider contract
  capabilities.ts         What YouVersion actually exposes
  officialApi.ts          The only working provider
  userExport.ts           Unavailable: no official export exists
  experimental.ts         Inert placeholder

sync/                   Turning remote data into vault state
  engine.ts               Reconciliation, cursor, conflicts, removals
  http.ts                 The single outbound HTTP path
  rateLimit.ts            Throttle, backoff, Retry-After
  hash.ts                 Change detection

markdown/               Turning domain objects into files
  note.ts                 Frontmatter + managed body for a highlight
  frontmatter.ts          YAML emission and block-level merging
  managedSection.ts       Managed/user region split
  escape.ts               Markdown escaping
  reference.ts            USFM to human reference
  paths.ts                Stable identity to vault path
  indexes.ts              Dashboard and index generation
  vaultIo.ts              Obsidian vault adapter wrapper

security/redact.ts      Everything loggable passes through here
diagnostics/            Redacted logger and the sanitized report
models/                 api.ts (wire shapes) and domain.ts (ours)
```

Two rules keep the layers honest:

- **API models never leak past a provider.** `models/api.ts` mirrors the wire format and is
  validated with Zod at the boundary. Providers translate into `models/domain.ts`. The sync engine
  has never heard of `passage_id`.
- **Everything that can be logged is redacted first.** `security/redact.ts` is the only way a
  string reaches the console or a diagnostics report.

## The decision that shapes everything: chapter scanning

`GET /v1/highlights` requires both `bible_id` and `passage_id`. There is no list endpoint, no
`since` filter, no pagination over a user's highlights. See `docs/api-research.md` for the
evidence.

So discovery is a **scan**: enumerate chapters from `GET /v1/bibles/{id}/index`, then ask each
chapter whether it has highlights. A chapter-level `passage_id` returns one entry per highlighted
verse, so the unit of work is a chapter, not a verse — ~1,189 requests for a whole Bible, ~260 for
the New Testament (the default).

That single constraint explains most of the design:

| Design element | Why it exists |
| --- | --- |
| Configurable scan scope | A whole-Bible scan is expensive; most users care about a subset |
| Resumable cursor | A 1,189-request run *will* be interrupted |
| Throttle + backoff | An unpublished rate limit plus a request-heavy scan |
| Manual-only default, 60-minute floor | Automatic scanning must not become abusive |
| Content hashing rather than date filtering | There are no timestamps to filter on |
| Natural-key identity | There is no remote row id |

## Identity, and why not titles

A highlight's identity is `${bible_id}:${passage_id}` — for example `3034:JHN.3.16`. It is
derived, not supplied, and it is stable because both components are stable. The vault path is
`Highlights/3034-JHN.3.16.md`.

Nothing keys off a note title or a reference string. A publisher renaming a book, or a user
changing their preferred translation's display name, cannot orphan a note.

## Reconciliation

For each highlight the engine has three inputs: the remote item, the note on disk (if any), and
the `SyncRecord` in plugin data. It decides in this order:

1. **No note on disk** — create it, record `syncHash` and `managedHash`.
2. **No sync markers in the note** — conflict. The user restructured it; we do not rewrite it.
3. **Managed region no longer matches `managedHash`** — the user edited inside the managed
   markers. Conflict, unless the policy is `overwrite`.
4. **`syncHash` unchanged and status is `synced`** — *unchanged*. Nothing is written at all, not
   even `last_synced_at`. Unchanged notes must not churn the vault, because a churning file wakes
   up every sync and backup tool the user runs.
5. **Otherwise** — replace only the managed region, merge only the managed frontmatter keys.

`syncHash` covers the fields sync controls and deliberately excludes `last_synced_at` (it changes
every run) and `imported_at` (it never changes), so an unchanged highlight hashes identically run
after run.

### Conflicts

The user's note is never modified when a conflict is detected. Under the default `preserve` policy
the version sync *would* have written goes to a `.sync-conflict.md` sidecar, so both versions
exist and the user can merge by hand. `skip` records the conflict without a sidecar; `overwrite`
lets the managed region win.

### Removals

Nothing is ever deleted. A highlight that disappears is marked `sync_status: missing_remote` or
moved to `Archive/`, per policy. Two guards prevent false positives:

- Removal detection only runs after a **complete** pass. A cancelled or partial run cannot conclude
  that anything has vanished.
- Only ids whose chapter was actually in the scanned scope are considered. Narrowing the scope from
  the whole Bible to the New Testament does not mean Genesis highlights were deleted.

### Interruption

The cursor is persisted **after** each chapter is fully reconciled, never before. A crash therefore
replays the last chapter rather than skipping it, and replay is harmless because reconciliation is
idempotent. The cursor carries a scope fingerprint; if the scope or Bible version changed, the
cursor is discarded rather than resuming at a meaningless index.

## Managed and user regions

```markdown
<!-- youversion-sync:managed:start -->
Generated. Rewritten every sync.
<!-- youversion-sync:managed:end -->

<!-- youversion-sync:user:start -->
## My notes
Yours. Never touched.
<!-- youversion-sync:user:end -->
```

`replaceManagedRegion` splices the managed region and reassembles everything else byte-for-byte —
including text before, between and after the marker pairs. Frontmatter merging is block-based for
the same reason: managed keys are replaced, and any key the user added survives with its original
formatting, including nested structures we could not faithfully round-trip through a YAML parser.

## Auth flow on desktop

The three-hop flow needs the middle hop to be a real browser navigation. The plugin gets that for
free by running a loopback HTTP listener:

```
Obsidian  ->  system browser  ->  /auth/authorize      (user consents)
              browser  ->  http://localhost:PORT/callback?state=...
              plugin responds 302  ->  /auth/callback?state=...
              browser  ->  http://localhost:PORT/callback?code=...&state=...
Obsidian  ->  POST /auth/token  (code + code_verifier)
```

`state` is validated on **every** hop before anything else happens. The listener binds to
`127.0.0.1` only, closes in a `finally`, and times out after five minutes.

## Mobile

**This release is desktop-only** (`isDesktopOnly: true`), and the reason is specific rather than
general laziness.

| Platform | Loopback listener | Custom scheme | Status |
| --- | --- | --- | --- |
| macOS / Windows / Linux | Yes (`node:http` via Electron) | `obsidian://` registered | **Supported** |
| iOS | No — no listener API | `obsidian://` works in-app | Blocked |
| Android | No | `obsidian://` works in-app | Blocked, plus `require_user_interaction=true` needed |

Obsidian mobile has no `node:http`, so the loopback receiver cannot run. Obsidian *does* provide
`registerObsidianProtocolHandler`, and `obsidian://` is exactly the kind of private-use scheme
RFC 8252 recommends for native apps — but whether the YouVersion Platform Portal accepts a
non-`http` callback URL is undocumented, and could not be tested without a developer account. That
is recorded as open question 6 in `docs/api-research.md`.

What has been done in the meantime: everything except the redirect receiver is
platform-independent. `sync/`, `markdown/`, `models/`, `security/` and `providers/` contain no
Node APIs and no Electron assumptions; all file access goes through Obsidian's vault adapter rather
than `node:fs`. Adding mobile support means writing one more receiver behind the existing
`LoopbackHandle` shape. **Mobile support is not claimed and has not been tested.**

## Provider seam

`Provider` exposes `availability()` and `highlights()`. The engine only ever sees a
`HighlightSource`, so it does not know or care whether items came from the API or a file.

- `OfficialApiProvider` — the only working one.
- `UserExportProvider` — unavailable, with a written explanation. The parsing seam is real; if
  YouVersion ships an export, only `parseExport` needs writing.
- `ExperimentalProvider` — inert. It contains no endpoints and no request code, deliberately.
  Deleting the file entirely cannot affect official highlight sync.

## What is deliberately not here

- **No writes to YouVersion.** `POST` and `DELETE /v1/highlights` exist; the plugin never calls
  them. The provider interface has no write method to call.
- **No telemetry.** No analytics, no crash reporting, no phone-home. The only network destination
  is `api.youversion.com`, and the bundle audit in `docs/release-checklist.md` checks that.
- **No undocumented endpoints, no scraping, no cookie extraction, no automated login.**
- **No verse text by default.** Licensing decides that, not convenience.
