# Manual testing checklist

Automated tests cover the logic against mocked HTTP and sanitized fixtures. They cannot cover the
OAuth round trip or the real API's actual behaviour. This is the list of things a human must do
once, with a real developer account.

Nothing here writes to your YouVersion account — the plugin only issues GETs plus the token
exchange.

## Setup

1. Register an app at <https://platform.youversion.com>.
2. Set the callback URL to exactly `http://localhost:51789/callback`.
3. Copy the App Key.
4. Build and install (see README), then enable the plugin in a **scratch vault**, not your real
   one, for the first run.
5. Paste the App Key into Settings → YouVersion Sync.
6. Set the scan scope to **Selected books** and enter a single short book, e.g. `JUD` (1 chapter),
   so the first run costs one request rather than 260.

## 1. Plugin loads

- [ ] No errors in the developer console (Ctrl/Cmd-Shift-I) on enable
- [ ] Settings tab renders
- [ ] Status bar shows "YouVersion: not connected"
- [ ] All six commands appear in the palette under "YouVersion Sync"
- [ ] Notes, Bookmarks and Plans show as disabled toggles with a reason
- [ ] Experimental connector shows "Not implemented"

## 2. OAuth connect — the highest-risk path

- [ ] "Connect account" opens the system browser at `api.youversion.com/auth/authorize`
- [ ] The consent screen names your app and **lists the highlights permission**
- [ ] Approving lands on a page saying "Connected to YouVersion"
- [ ] Obsidian shows "Connected to YouVersion"
- [ ] Settings shows connected, with the highlights permission granted
- [ ] Your display name appears (this proves JWKS verification of the `id_token` worked)

Inspect the browser's network tab during the flow and confirm the three hops:

- [ ] `/auth/authorize` → 303 to `localhost:51789/callback?state=…` **with no `code`**
- [ ] `localhost:51789/callback` → 302 to `/auth/callback?state=…`
- [ ] `/auth/callback` → 302 back to `localhost:51789/callback?code=…&state=…`

> If YouVersion changes this flow again, this is where it will show. Open question 1 in
> `docs/api-research.md` records that a second, older endpoint set (`/oauth/*`) also appears in
> their OpenAPI document.

### Failure paths

- [ ] Deny consent → a clear message, no crash, still disconnected
- [ ] Start a connect, close the browser tab, wait 5 min → times out cleanly
- [ ] Occupy port 51789 (`nc -l 51789`) then connect → an actionable "port in use" message
- [ ] Connect with an empty App Key → told to add one first
- [ ] Connect with a *wrong* App Key → a clear failure, not a silent hang

## 3. Token handling

- [ ] Open `.obsidian/plugins/youversion-sync/data.json` — tokens are present under `tokens`
- [ ] Switch storage to **Session only**, reconnect, check `data.json` again → `tokens` is `null`
- [ ] Restart Obsidian with Session only → disconnected, as documented
- [ ] Restart with **This device** → still connected
- [ ] Disconnect → `tokens` is `null` and the status bar updates
- [ ] Grep the vault for any token: `grep -rF "eyJ" <vault> --include="*.md"` → **no matches**

## 4. Refresh

Access tokens last ~1 hour.

- [ ] Connect, wait out the hour (or edit `expiresAt` in `data.json` to a past value), then sync
- [ ] The sync succeeds without re-prompting for consent
- [ ] `data.json` shows a new `expiresAt`

## 5. Chapter-level highlights query — **verify this first**

This is open question 3 in `docs/api-research.md`, and the entire scan design depends on it.

Before syncing, highlight **two different verses in the same chapter** in the YouVersion app
(e.g. John 3:16 and John 3:17), using the same Bible version id you configured.

- [ ] Set scope to Selected books → `JHN`, sync
- [ ] **Both** verses produce notes

If only one appears, or none, a chapter-level `passage_id` does not behave as documented and the
scan must fall back to per-verse queries. Record what actually happened in
`docs/api-research.md` before changing anything.

Also confirm with curl, substituting your key and token:

```bash
curl -sS "https://api.youversion.com/v1/highlights?bible_id=3034&passage_id=JHN.3" \
  -H "X-YVP-App-Key: $YVP_APP_KEY" -H "Authorization: Bearer $TOKEN" | jq .
```

- [ ] Returns one entry per highlighted verse in the chapter
- [ ] A chapter with no highlights returns **204**, not an error

## 6. First sync

- [ ] Progress notice counts chapters
- [ ] Summary reports created/updated/unchanged/conflicts/failures
- [ ] Notes appear under `Sources/YouVersion/Highlights/`
- [ ] Filenames are `<bible_id>-<usfm>.md`
- [ ] Frontmatter matches `docs/markdown-format.md`
- [ ] **No `created_at` or `updated_at` fields**
- [ ] `Dashboard.md` and `Indexes/*.md` exist
- [ ] Dashboard states plainly that notes, bookmarks and plans are unavailable

## 7. Incremental behaviour

- [ ] Sync again with nothing changed → everything reported **unchanged**, zero written
- [ ] Note file modification times are **unchanged** (this is the anti-churn guarantee)
- [ ] Change a highlight's color in the YouVersion app, sync → reported **updated**, new color
- [ ] `imported_at` is unchanged after the update; `last_synced_at` moved

## 8. Your content is safe

- [ ] Write a paragraph under `## My notes`, sync → the paragraph survives verbatim
- [ ] Add `my_rating: 5` to a note's frontmatter, sync → still there
- [ ] Add `aliases:` with two list items, sync → both survive with formatting intact
- [ ] Edit text *inside* the managed markers, sync → reported as a **conflict**, your note
      untouched, a `.sync-conflict.md` sidecar appears
- [ ] Delete the sync markers from a note, sync → conflict, note untouched
- [ ] Set conflict policy to `overwrite`, repeat → the managed region is replaced

## 9. Removals

- [ ] Remove a highlight in the YouVersion app, sync → the note remains, marked
      `sync_status: missing_remote`
- [ ] Set removal policy to `archive`, repeat → the note moves to `Archive/`, still not deleted
- [ ] Narrow the scan scope to exclude a book you have highlights in, sync → those notes are
      **not** marked missing

## 10. Interruption and resumption

- [ ] Set scope to Whole Bible, start a sync, cancel it via "Cancel running sync"
- [ ] Summary says cancelled; `data.json` has a `cursor`
- [ ] Sync again → it resumes near where it stopped, not from Genesis
- [ ] Start a sync and force-quit Obsidian mid-run; reopen and sync → resumes, no duplicate notes
- [ ] Change the Bible version, sync → the stale cursor is discarded and the scan restarts

## 11. Rate limiting

- [ ] Run a Whole Bible scan and watch the console with diagnostic logging on
- [ ] Requests are spaced, not fired in a burst
- [ ] If a 429 occurs, the log shows a retry rather than a failure
- [ ] The sync completes, or fails with a clear message

## 12. Verse text and licensing

- [ ] With "Download verse text" **off** (default), notes contain no scripture text
- [ ] Turn it on with a public-domain version (e.g. 3034/BSB), sync → text appears as a blockquote
- [ ] A copyright callout accompanies the text
- [ ] Try a version whose licence you have **not** accepted → the highlight still syncs, just with
      no verse text and no error storm

## 13. Commands

- [ ] "Show sync status" reports counts and the last sync
- [ ] "Rebuild generated indexes" works **with the network disconnected**
- [ ] "Import official data export" explains that no official export exists
- [ ] "Disconnect account" clears tokens
- [ ] "Delete locally imported YouVersion data" asks for confirmation first

For the delete command, first place a hand-written note inside `Sources/YouVersion/`:

- [ ] Plugin-created notes are deleted
- [ ] **Your hand-written note is not**, and the summary says how many were left alone

## 14. Diagnostics

- [ ] "Copy sanitized diagnostics" puts a report on the clipboard
- [ ] Search it for `eyJ`, `Bearer`, your email, your App Key, and any verse text → **no matches**
- [ ] Status codes and counts are present and plausible
- [ ] With diagnostic logging on, console lines show redacted URLs — no `code=`, no `state=`

## 15. Mobile

The manifest declares `isDesktopOnly: true`, so Obsidian mobile will not install it.

If you sideload it anyway for testing:

- [ ] "Connect account" refuses with an explanation rather than throwing

## Recording results

Note the date, plugin version, Obsidian version and OS. Anything that contradicts
`docs/api-research.md` should be written back into that file — especially step 5.
