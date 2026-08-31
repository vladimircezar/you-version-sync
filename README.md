# YouVersion Sync for Obsidian

Sync your YouVersion **highlights** into your Obsidian vault as durable Markdown, with stable
identifiers, incremental updates, and a region of every note that sync will never touch.

> **Desktop only in this release.** See [Mobile](#mobile).

---

## Disclosures

Required by Obsidian's [Developer policies](https://docs.obsidian.md/Community+directory/Developer+policies),
and worth knowing before you install:

- **An account is required.** You need a YouVersion account and your own free developer App Key
  from [platform.youversion.com](https://platform.youversion.com). The plugin does nothing useful
  without one.
- **Network use.** The plugin contacts exactly one remote service, `api.youversion.com`, and only
  to: sign you in (OAuth), refresh your access token, read the Bible book/chapter index, read your
  highlights, and — only if you turn it on — fetch verse text. It contacts nothing else. You can
  verify that against the built bundle: `grep -oE 'https://[a-z0-9.-]+' main.js | sort -u`.
- **No telemetry.** No analytics, no crash reporting, no usage data, client-side or otherwise.
- **No payment.** Free, MIT licensed, no paid tier.
- **Files outside your vault.** None are read or written. Tokens live in the plugin's own
  `data.json` inside `.obsidian/`, which is part of your vault.
- **Node APIs.** A loopback HTTP listener on `127.0.0.1` receives the OAuth redirect during
  sign-in only. This is why the plugin is marked desktop-only.

---

## What you should know before installing

**Highlights are the only thing this plugin can import.** Not because it is unfinished — because
they are the only user data YouVersion's public API exposes.

| Data type | Supported | Why |
| --- | --- | --- |
| **Highlights** | **Yes** | `highlights` is the one user-data permission YouVersion offers |
| Notes | No | YouVersion's docs state notes are not a supported permission; no endpoint exists |
| Bookmarks / saved verses | No | Same — not a supported permission, no endpoint |
| Reading-plan subscriptions | No | No plan endpoint exists in the public API |
| Reading-plan progress | No | As above |
| Completed plans | No | As above |

This was verified against YouVersion's own documentation and published OpenAPI document on
**2026-08-30**. The evidence, including the complete endpoint list, is in
[`docs/api-research.md`](docs/api-research.md).

There is also a second thing worth knowing up front, because it shapes how the plugin behaves:

**The API cannot list your highlights.** `GET /v1/highlights` requires you to name a specific Bible
version *and* a specific passage — it answers "is this passage highlighted?", not "what have I
highlighted?". There is no list endpoint and no "changed since" filter. So the plugin discovers
highlights by **scanning chapters**: ~260 requests for the New Testament, ~1,189 for a whole Bible.
That is why scan scope, throttling and resumable syncs are front and centre rather than
afterthoughts.

## What you get

- OAuth 2.0 with PKCE. Your password is never requested, seen or stored.
- One Markdown note per highlighted verse, with YAML frontmatter and a stable filename.
- **Incremental**: an unchanged highlight is not rewritten — the file is not even touched.
- **Idempotent**: run it a hundred times, get the same vault.
- **Restartable**: interrupt a 1,189-chapter scan and it resumes where it stopped.
- **Non-destructive**: sync never deletes a note. Removed highlights get marked or archived.
- **Your writing is safe**: every note has a user-owned region that sync will not modify, and
  frontmatter keys you add survive untouched.
- Generated `Dashboard.md` and index notes, rebuildable offline from your vault alone.
- A sanitized diagnostics report that is safe to paste into a public issue.
- No telemetry. One network host: `api.youversion.com`.

---

## Installing

The plugin is not yet in the community catalogue. Build it and install manually.

### Build

```bash
git clone <this-repo> && cd Youversion-Plugin
npm install
npm run build
```

That produces `main.js` in the repository root.

### Install into a vault

```bash
mkdir -p "/path/to/YourVault/.obsidian/plugins/youversion-sync"
cp main.js manifest.json styles.css "/path/to/YourVault/.obsidian/plugins/youversion-sync/"
```

Then in Obsidian: **Settings → Community plugins → Installed plugins** → reload, and enable
**YouVersion Sync**.

> Try it in a scratch vault first. It only ever adds files, but it is your vault.

---

## OAuth setup

You need your own YouVersion developer App Key. There is no shared key, and there should not be.

1. Go to <https://platform.youversion.com> and sign in with your YouVersion account.
2. Create an application.
3. Set the callback URL to **exactly**:

   ```
   http://localhost:51789/callback
   ```

   It must match character for character. `127.0.0.1` instead of `localhost`, a trailing slash,
   `https`, or a missing `/callback` will all fail with
   `redirect_uri does not match registered callback URL`. The plugin's settings show the exact
   string with a **Copy** button — use that rather than retyping it. If port 51789 is taken on
   your machine, change it in settings first and register the URI it then shows.
4. Copy the **App Key**.
5. In Obsidian: **Settings → YouVersion Sync**, paste the App Key.
6. Run **YouVersion Sync: Connect account** (or press Connect in settings).
7. Your browser opens YouVersion's sign-in. Approve the **highlights** permission — without it,
   there is nothing to sync.

Your App Key identifies the *application*, not you. It is not a password, but it is yours; don't
publish it.

### What happens during connect

The plugin runs a listener on `127.0.0.1` for the duration of the flow, because YouVersion's
sign-in requires a browser redirect and one of its three hops must be a real top-level navigation.
The listener binds to loopback only, is used solely to receive the redirect, and shuts down when
the flow ends or times out. Details in [`docs/architecture.md`](docs/architecture.md).

---

## Using it

### Commands

| Command | What it does |
| --- | --- |
| `YouVersion Sync: Connect account` | Runs the OAuth flow |
| `YouVersion Sync: Sync now` | Scans the configured scope and writes notes |
| `YouVersion Sync: Import official data export` | Explains that no official export exists |
| `YouVersion Sync: Show sync status` | Counts, last sync, pending resume |
| `YouVersion Sync: Rebuild generated indexes` | Regenerates Dashboard and indexes offline |
| `YouVersion Sync: Disconnect account` | Discards tokens locally |
| `YouVersion Sync: Cancel running sync` | Stops a scan; progress is kept |

### Scan scope

| Scope | Requests per sync | Time |
| --- | --- | --- |
| **Whole Bible** (default) | ~1,189 | a few minutes |
| New Testament only | ~260 | about a minute |
| Old Testament only | ~929 | a few minutes |
| Selected books | a few to a few dozen | seconds |

**The default scans everything, on purpose.** A narrower scope is faster, but highlights outside it
are not imported — they are never even looked for. A sync that silently omits most of your
highlights is worse than a slow one, so completeness is the default and speed is opt-in.

If you do narrow it, the plugin says so after every sync and puts a warning at the top of
`Dashboard.md`, so a partial view is never mistaken for "you have no highlights there".

A full scan is resumable, cancellable, and shows progress, so the first run taking a few minutes
costs you nothing but waiting.

Automatic sync is **off** by default, and cannot be set below 60 minutes when enabled. A sync is a
few hundred HTTP requests; running it every five minutes would be abusive to a free API.

### Where things land

```
Sources/YouVersion/
  Dashboard.md
  Highlights/3034-JHN.3.16.md
  Indexes/Highlights.md, Notes.md, Bookmarks.md, Plans.md
```

Folders are only created for data types that exist. The `Notes.md`, `Bookmarks.md` and `Plans.md`
*index* notes are written anyway, each explaining why it is empty — so the gap is visible rather
than looking like a bug.

### One note per verse, or one per chapter

**Highlight organization** in settings picks between:

- **One note per verse** (default) — `Highlights/3034-JHN.3.16.md`, one file per highlighted verse.
- **One note per chapter** — `Highlights/3034-JHN.3.md`, listing every highlighted verse in that
  chapter under its own subheading, with a `highlight_count` in the frontmatter.

Per-chapter suits people who highlight densely and would rather not have hundreds of one-line
notes. The two use separate identifiers, so switching leaves your existing notes intact rather than
mangling them — sync simply stops maintaining the set you switched away from. Delete those yourself
if you no longer want them.

Full format reference: [`docs/markdown-format.md`](docs/markdown-format.md).

### Writing in your notes

Every note looks like this:

```markdown
<!-- youversion-sync:managed:start -->
Generated. Rewritten on every sync.
<!-- youversion-sync:managed:end -->

<!-- youversion-sync:user:start -->
## My notes

Whatever you write here is yours.
<!-- youversion-sync:user:end -->
```

Write inside the **user** region. Sync splices out only the managed region and puts everything else
back byte-for-byte. Frontmatter works the same way — add `aliases`, `cssclass`, your own rating
field, anything; it survives.

If you edit *inside* the managed markers, sync notices and reports a **conflict** instead of
overwriting you. Your note is left exactly as you wrote it, and the version sync would have written
appears alongside as `<id>.sync-conflict.md` so you can merge by hand.

### Verse text is off by default

Bible translations are licensed individually and most are not public domain. Storing verse text in
your vault is local reproduction, so it is opt-in, per your responsibility, and when enabled the
publisher's copyright line is stored with every note.

---

## Where your tokens live

**Obsidian gives community plugins no OS keychain.** There is no secure-storage API. So:

Tokens are stored in `<vault>/.obsidian/plugins/youversion-sync/data.json`, **in plain text**. They
are never written into your Markdown, and never into a log or diagnostics report — but that file is
readable by anything that can read your vault folder.

They are deliberately *not* "encrypted" with a key stored beside them. That looks like security
without being any.

If that trade-off doesn't suit you, set **Token storage → Session only**: tokens stay in memory and
you reconnect after each Obsidian restart.

Full detail, including what is redacted and what the diagnostics report contains:
[`docs/privacy-and-security.md`](docs/privacy-and-security.md).

---

## Mobile

Not supported in this release, and the manifest says so (`isDesktopOnly: true`).

The OAuth redirect needs a local HTTP listener, which Obsidian mobile cannot provide. A custom
`obsidian://` scheme is the standard alternative for native apps, but whether the YouVersion
Platform Portal accepts a non-`http` callback URL is undocumented and could not be tested without
a developer account.

The sync, storage and Markdown layers are already platform-independent — no Node APIs, all file
access through Obsidian's vault adapter — so adding mobile means writing one more redirect
receiver. **Mobile support is not claimed and has not been tested.**

---

## Development

```bash
npm install
npm run dev        # watch build
npm test           # 189 unit tests, no network, no account needed
npm run verify     # format + lint + typecheck + test + build
```

Requires Node 20.17+ or 22+. `npm run verify` must be clean before a release, and so must
`npm audit` — see [`docs/release-checklist.md`](docs/release-checklist.md).

Tests use hand-written sanitized fixtures. No real account data exists in this repository, and no
test requires a live YouVersion account or a valid App Key.

| Doc | Contents |
| --- | --- |
| [`docs/api-research.md`](docs/api-research.md) | What the API exposes, with evidence and open questions |
| [`docs/architecture.md`](docs/architecture.md) | Module layout and the reasoning behind the design |
| [`docs/privacy-and-security.md`](docs/privacy-and-security.md) | Token storage, redaction, threat model |
| [`docs/markdown-format.md`](docs/markdown-format.md) | Note format, frontmatter, Dataview examples |
| [`docs/manual-testing.md`](docs/manual-testing.md) | What a human must verify with a real account |
| [`docs/release-checklist.md`](docs/release-checklist.md) | Compliance, audit and release steps |

---

## What this plugin will not do

Not "hasn't got to yet" — will not:

- Ask for or handle your YouVersion password
- Modify or delete anything in your YouVersion account (it is read-only; the write endpoints exist
  and are never called)
- Scrape the web app, extract cookies, automate login, or bypass a CAPTCHA
- Use undocumented or private endpoints
- Send telemetry or analytics
- Delete your notes during a sync

An "experimental connector" for unofficial data access is deliberately a disabled placeholder
containing no endpoints and no request code. Building one would need a separate explicit decision
and a security review first.

---

## Licence

MIT. See [LICENSE](LICENSE).

Not affiliated with, endorsed by, or sponsored by YouVersion or Life.Church. "YouVersion" and
"Bible App" are trademarks of their respective owners.
