# YouVersion API research

**Research date: 2026-08-30.** Everything below was verified against YouVersion's own
documentation on that date. Where the documentation is ambiguous or self-contradictory, that is
recorded as an open question rather than resolved by guesswork.

## Sources consulted

| Source | URL | What it provided |
| --- | --- | --- |
| Developer docs index | <https://developers.youversion.com/> | Navigation, doc set |
| Machine-readable doc index | <https://developers.youversion.com/llms.txt> | Canonical list of doc pages |
| Sign-in APIs | <https://developers.youversion.com/sign-in-apis> | The full OAuth/OIDC + PKCE flow, scopes vs. permissions, JWT handling |
| API usage | <https://developers.youversion.com/api-usage> | App Key header, base URL, pagination |
| Error codes | <https://developers.youversion.com/error-codes> | Status codes, 429 / `Retry-After` guidance |
| API reference (OpenAPI) | <https://developers.youversion.com/api> | The complete published endpoint list and schemas |
| Platform portal | <https://platform.youversion.com/> | App registration, licences, terms |

The API reference page is a client-rendered viewer over a bundled OpenAPI document. The endpoint
list and schemas quoted below were read from that document as served to the page, not inferred
from prose.

## Capability matrix

| Data type | Available? | Evidence |
| --- | --- | --- |
| **Highlights** | **Yes** | `requested_permissions[]=highlights` is documented, and `GET /v1/highlights` exists. |
| Notes | No | Sign-in docs: the only supported permission is `highlights`; notes and bookmarks are "not supported and must not be requested". No notes endpoint exists in the OpenAPI document. |
| Bookmarks / saved verses | No | Same statement; no bookmarks or saved-verses endpoint exists. |
| Reading-plan subscriptions | No | No plan endpoint of any kind exists, and no plan permission can be requested. |
| Reading-plan progress | No | As above. |
| Completed plans | No | As above. |

### The complete published endpoint list

This is every path in the OpenAPI document, which is how the "no notes / no bookmarks / no plans"
conclusion is reached — not by failing to find them, but by enumerating what exists:

```
/data-exchange
/data-exchange/token
/v1/bibles
/v1/bibles/{bible_id}
/v1/bibles/{bible_id}/index
/v1/bibles/{bible_id}/passages/{passage_id}
/v1/bibles/{bible_id}/books
/v1/bibles/{bible_id}/books/{book_id}
/v1/bibles/{bible_id}/books/{book_id}/chapters
/v1/bibles/{bible_id}/books/{book_id}/chapters/{chapter_id}
/v1/bibles/{bible_id}/books/{book_id}/chapters/{chapter_id}/verses
/v1/bibles/{bible_id}/books/{book_id}/chapters/{chapter_id}/verses/{verse_id}
/v1/highlights
/v1/highlights/{passage_id}
/v1/fonts, /v1/fonts/{id}, /v1/fonts/{id}/stylesheet
/v1/languages, /v1/languages/{id}
/v1/licenses
/v1/apps/{app_id}, /v1/apps/{app_id}/permissions
/v1/organizations, /v1/organizations/{id}, /v1/organizations/{id}/bibles
/v1/verse_of_the_days, /v1/verse_of_the_days/{day}
```

## The finding that shapes the whole plugin

**`GET /v1/highlights` cannot enumerate a user's highlights.**

Both query parameters are **required**:

| Parameter | In | Required | Type |
| --- | --- | --- | --- |
| `bible_id` | query | **yes** | integer |
| `passage_id` | query | **yes** | string (verse *or chapter* USFM) |

There is no "list all highlights" route, no `since` / `updated_after` filter, and no pagination
over a user's highlights. The only question the API can answer is *"is this passage highlighted?"*.

Two consequences follow, and both are visible throughout the codebase:

1. **Discovery requires a scan.** Because `passage_id` accepts a *chapter* USFM (`JHN.3`) and the
   response is documented as returning "a color per verse without ranges", one request per chapter
   discovers all highlights in that chapter. A whole Bible is ~1,189 chapters. The plugin therefore
   walks chapters, defaults to a New Testament scope (~260 chapters), throttles requests, and keeps
   a resumable cursor. `GET /v1/bibles/{id}/index` supplies the book/chapter hierarchy in one call.

2. **There is no remote id and there are no timestamps.** The response object is exactly
   `{bible_id, passage_id, color}`. So:
   - identity is the natural key `bible_id:passage_id` (stable by construction), and
   - `created_at` / `updated_at` are **omitted** from note frontmatter rather than invented.
     Incrementality comes from content hashing and cursor resumption, not from a date filter.

### Highlight response schema

```json
{ "data": [ { "bible_id": 3034, "passage_id": "MAT.1.1", "color": "44aa44" } ] }
```

`color` is lowercase 6-digit hex with no leading `#`. A chapter with no highlights returns
**204 No Content**, which is a normal answer and not an error.

`POST /v1/highlights` and `DELETE /v1/highlights/{passage_id}` exist (scopes `write_highlights`).
**This plugin never calls them.** Version 1 is strictly read-only.

## Authentication

OAuth 2.0 authorization code with PKCE, layered over OpenID Connect. Base URL
`https://api.youversion.com`.

### Scopes are not permissions

This distinction is documented explicitly and is easy to get wrong:

- **OAuth `scope`** selects OIDC identity claims. The only accepted values are `openid`, `profile`
  and `email`; `openid` is required. Since the July 2026 change, any other value is rejected with
  `400 invalid_scope` rather than ignored.
- **`requested_permissions[]`** requests access to user data. The only supported value is
  `highlights`.

Putting `highlights` in `scope` is an error. See `src/auth/oauth.ts`, which keeps the two apart,
and the tests in `tests/providers.test.ts` that assert it.

### The three-hop flow

A breaking change on 20–21 July 2026 means the first callback after consent carries **`state`
only** — no `yvp_id`, `user_name`, `user_email` or `profile_picture`. Identity is bound
server-side.

1. **`GET /auth/authorize`** — `response_type=code`, `client_id` (the App Key), `redirect_uri`,
   `scope=openid profile email`, `nonce`, `state`, `code_challenge`, `code_challenge_method=S256`,
   `requested_permissions[]=highlights`. Android also needs `require_user_interaction=true`.
2. Browser lands on the redirect URI with `?state=...` (and optionally `granted_permissions=`).
   Validate `state`, then **replay `state` alone** to **`GET /auth/callback`** as a *top-level
   browser navigation* — a `fetch` cannot read the `Location` of the resulting redirect. That hop
   302s back to the redirect URI with `?code=...&state=...`.
3. **`POST /auth/token`** — `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`,
   `code_verifier`. Public client: no secret. Returns `access_token`, `refresh_token`, `id_token`,
   `expires_in` (~3599, and documented as a *string*), `token_type`, `scope`.

The plugin satisfies the top-level-navigation requirement by answering the first loopback hit with
a 302 to `/auth/callback`, so the browser performs the navigation itself
(`src/auth/loopback.ts`).

### Token validation

- Issuer: `https://api.youversion.com`
- Audience: your App Key
- JWKS: `https://api.youversion.com/.well-known/jwks.json`
- OIDC discovery URL: **not available**
- Signatures must be verified, with an allow-list of asymmetric algorithms (RS256), plus `iss`
  and `aud` checks. Implemented in `src/auth/jwt.ts`.
- `yvp_id` is the stable user identifier; email is explicitly not stable.

## Other API facts used

- **App Key header:** every request needs `X-YVP-App-Key`. It identifies the *app*, not the user;
  user data additionally needs `Authorization: Bearer <access_token>`.
- **Pagination:** `page_size` / `page_token`, up to ~100 items per page, with `next_page_token` in
  the response. Not applicable to `/v1/highlights`, which has no pagination parameters.
- **Bible index** (`/v1/bibles/{id}/index`) returns books with `canon`
  (`old_testament` / `new_testament` / `deuterocanon`), chapters with `passage_id`, and verse
  lists. Used for scan planning and for localised book titles.
- **Bible metadata** (`/v1/bibles/{id}`) includes `copyright` and `promotional_content`, the
  publisher-supplied copyright text that must accompany stored scripture text.
- **Granted permissions** can be re-checked via `GET /v1/apps/{app_id}/permissions`, whose response
  enum is `["highlights"]` — independent confirmation that no other permission exists.

## Rate limits

**No numeric rate limit is published.** The error-codes page says rate limiting "may" be
implemented, and documents 429 with `Retry-After`. Because a chapter scan is request-heavy, the
plugin is conservative by default: a minimum interval between requests, full-jitter exponential
backoff, bounded retries, unconditional obedience to `Retry-After`, a default scope of the New
Testament rather than the whole Bible, and a minimum automatic-sync interval of 60 minutes with
manual-only as the default.

## Licensing of scripture text

Bible text is licensed per translation; the Platform Portal requires accepting a licence agreement
per Bible. `GET /v1/licenses` reports agreement status. The API is documented as non-commercial
use. Because storing verse text in a user's vault is redistribution-adjacent and depends entirely
on the translation's licence, **downloading verse text is off by default**, and when it is enabled
the publisher's `copyright` string is stored alongside the text.

## Official data export

**None found.** YouVersion publishes no account-data export or downloadable archive for Bible App
user data. Checked: the developer documentation set (all pages in `llms.txt`), the Platform Portal,
and the published endpoint list — the Portal covers app registration and licence agreements, not
per-user data export. The plugin therefore ships the export provider as explicitly unavailable with
that explanation, and does not invent a file format. See `src/providers/userExport.ts`.

## Open questions and uncertainties

These are recorded rather than guessed at. None of them block the highlights milestone.

1. **Two documented OAuth endpoint sets.** The OpenAPI `securitySchemes` block describes an
   `authorizationCode` flow at `/oauth/authorize` and `/oauth/token` with scopes `read_highlights`
   and `write_highlights`. The Sign-in APIs page — which is newer, carries the July 2026 breaking
   change, and is written as the authoritative integration guide — documents `/auth/authorize`,
   `/auth/callback` and `/auth/token`, with data access via `requested_permissions[]` rather than
   scopes. **This plugin follows the Sign-in APIs page.** The `/oauth/*` paths look like a stale or
   internal representation, but this has not been confirmed with YouVersion.

2. **Refresh-token grant is not documented.** The docs say to use the refresh token and to "call
   the token revocation endpoint" on logout, but neither the refresh request shape nor a revocation
   endpoint is specified. The plugin implements the standard RFC 6749 refresh
   (`grant_type=refresh_token`, `refresh_token`, `client_id`) and, having no documented revocation
   endpoint, discards tokens locally on disconnect and tells the user to remove the app from their
   YouVersion account to revoke access fully. **Unverified against a live server.**

3. **Chapter-level `passage_id` on `GET /v1/highlights`.** The parameter is documented as accepting
   "verse or chapter USFM format" and the response as "a color per verse without ranges", which
   together imply a chapter query returns every highlighted verse in that chapter. The whole scan
   design rests on this. It has **not been verified against a live account** (no App Key was
   available during development). This is the single most important thing to confirm during manual
   testing — see `docs/manual-testing.md`, step 5.

4. **Rate limits** are unpublished, so the defaults are guesses on the conservative side.

5. **`expires_in` type.** Documented as the string `"3599"`. The client accepts either a string or
   a number.

6. **Whether the Platform Portal accepts a non-`http` callback URL** (e.g. a custom scheme such as
   `obsidian://`) is not documented. This decides whether mobile OAuth is possible at all — see
   `docs/architecture.md`.

## Re-verifying this document

The docs are served as raw Markdown, which makes rechecking cheap:

```bash
curl -s https://developers.youversion.com/llms.txt
```

Then fetch any page by appending `.md` to its path, e.g.
`https://developers.youversion.com/sign-in-apis.md`. If a `notes`, `bookmarks` or `plans`
permission ever appears, update `src/providers/capabilities.ts` and this file together.
