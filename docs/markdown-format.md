# Markdown format

## Folder layout

```
Sources/
  YouVersion/
    Dashboard.md
    Highlights/
      3034-JHN.3.16.md
      3034-JHN.3.16.sync-conflict.md    (only when a conflict is detected)
    Archive/                            (only when the removal policy is "archive")
    Indexes/
      Highlights.md
      Notes.md
      Bookmarks.md
      Plans.md
```

`Notes/`, `Bookmarks/` and `Plans/` item folders are **not created**, because those data types
cannot be imported. The corresponding *index* notes are written, so the absence is explicit rather
than looking like a silent failure.

The root is configurable; `Sources/YouVersion` is the default.

## Filenames

`Highlights/<stable-item-id>.md`, where the id is `<bible_id>-<usfm>`.

The identity is `bible_id:passage_id` — the natural key, because the API supplies no row id. It is
stable by construction, and nothing keys off a note title or reference string.

## A highlight note

```markdown
---
source: youversion
youversion_type: highlight
youversion_id: "3034:JHN.3.16"
reference: "John 3:16"
usfm: JHN.3.16
bible_version_id: 3034
bible_version: BSB
color: "#44aa44"
youversion_url: "https://www.bible.com/bible/3034/JHN.3.16"
imported_at: "2026-08-30T12:00:00.000Z"
last_synced_at: "2026-08-30T12:00:00.000Z"
sync_hash: 3f8a1c92e04b77de
sync_status: synced
tags:
  - source/youversion
  - bible/highlight
---

<!-- youversion-sync:managed:start -->

# John 3:16

*Verse text is not stored locally. Open the reference in YouVersion to read it.*

[Open in YouVersion](https://www.bible.com/bible/3034/JHN.3.16)

Highlighted in **BSB (3034)** with color `#44aa44`.

<!-- youversion-sync:managed:end -->

<!-- youversion-sync:user:start -->

## My notes


<!-- youversion-sync:user:end -->
```

With "Download verse text" enabled, the placeholder line is replaced by the verse as a blockquote,
followed by a collapsed copyright callout.

## Frontmatter fields

| Field | Always present? | Notes |
| --- | --- | --- |
| `source` | yes | Always `youversion`. Used to identify notes the plugin owns. |
| `youversion_type` | yes | `highlight` |
| `youversion_id` | yes | `<bible_id>:<usfm>` |
| `reference` | yes | Human reference, localised from the Bible index where possible |
| `usfm` | yes | e.g. `JHN.3.16` |
| `bible_version_id` | yes | Numeric version id |
| `bible_version` | when known | Abbreviation, e.g. `BSB` |
| `color` | yes | `#` + the API's lowercase hex |
| `youversion_url` | yes | Canonical bible.com link |
| `imported_at` | yes | When *this plugin* first wrote the note. Preserved across updates. |
| `last_synced_at` | yes | When sync last wrote the note |
| `sync_hash` | yes | Change detector over sync-controlled fields |
| `sync_status` | yes | `synced`, `missing_remote` or `conflict` |
| `tags` | yes | `source/youversion`, `bible/highlight` |

### Fields you will not see, and why

`created_at` and `updated_at` are **absent**. The highlights API returns exactly
`{bible_id, passage_id, color}` — no timestamps at all. Emitting a fabricated or
imported-time-derived `created_at` would be a lie in a field people sort by. See
`docs/api-research.md`.

`imported_at` and `last_synced_at` describe *the plugin's* actions, which the plugin does know, so
they are legitimate.

All timestamps are UTC ISO 8601.

## Managed and user regions

```markdown
<!-- youversion-sync:managed:start -->
Generated. Rewritten on every sync.
<!-- youversion-sync:managed:end -->

<!-- youversion-sync:user:start -->
Yours. Never touched.
<!-- youversion-sync:user:end -->
```

**Only the managed region is ever rewritten.** Sync splices it out and reassembles everything else
byte-for-byte, including text before, between and after the marker pairs. Your whitespace survives
exactly as you left it.

Frontmatter behaves the same way: the plugin replaces only the keys listed above and leaves every
other key untouched, with its original formatting and nesting. Add `aliases`, `cssclass`,
`my_rating`, whatever — it survives.

Write below `## My notes`, or anywhere inside the user markers. Never write inside the managed
markers: that is detected as a conflict on the next sync (which is safe, but it means the note
stops updating until you resolve it).

## Highlight organization

Two strategies, set in settings:

**One note per verse** (default) - `Highlights/3034-JHN.3.16.md`, `youversion_type: highlight`,
identity `3034:JHN.3.16`.

**One note per chapter** - `Highlights/3034-JHN.3.md`, `youversion_type: highlight-chapter`,
identity `3034:JHN.3`. The note lists every highlighted verse in the chapter under its own
subheading, and carries `highlight_count`. There is no single `color` for a chapter, so that field
is omitted and each verse shows its own color in the body.

The two id spaces do not collide, so switching strategies leaves the old notes in place rather than
corrupting them. Sync will stop maintaining the notes from the strategy you switched away from;
delete them yourself if you no longer want them.

## Conflicts

A conflict is recorded when the managed region has changed since the plugin last wrote it, or when
the markers are missing entirely.

**Your note is never modified.** Under the default `preserve` policy, the version sync *would* have
written is placed in `<id>.sync-conflict.md` alongside it, with a callout explaining what happened.
Merge what you want, delete the sidecar, and the next sync resumes normally.

- `preserve` (default) — keep yours, write the sidecar
- `skip` — keep yours, no sidecar
- `overwrite` — let the managed region be replaced

## Removed highlights

Notes are never deleted by sync.

- `mark` (default) — `sync_status: missing_remote`, note stays put
- `archive` — moved to `Archive/`, status marked
- `ignore` — untouched

Removal is only detected after a *complete* pass over the scope, and only for chapters that were
actually scanned. Narrowing the scan scope does not mark the excluded books as missing.

## Generated files

`Dashboard.md` and everything under `Indexes/` are regenerated on every sync and by the
"Rebuild generated indexes" command. **Do not edit them** — they carry a notice saying so.

They are rebuilt by reading the notes already in your vault, never by calling the API, so the
command works offline and after restoring a backup.

## Dataview

Not required. The generated indexes are plain Markdown tables.

If you do use Dataview, the frontmatter is designed to be queryable:

````markdown
```dataview
TABLE reference, bible_version, color, sync_status
FROM "Sources/YouVersion/Highlights"
WHERE source = "youversion"
SORT usfm ASC
```
````

Highlights in one book:

````markdown
```dataview
LIST
FROM "Sources/YouVersion/Highlights"
WHERE source = "youversion" AND startswith(usfm, "JHN")
```
````

Anything needing attention:

````markdown
```dataview
TABLE sync_status, last_synced_at
FROM "Sources/YouVersion"
WHERE source = "youversion" AND sync_status != "synced"
```
````

## Escaping

Text from the API is escaped before it is interpolated: inline Markdown characters are escaped in
prose, pipes and newlines are handled in table cells, and quoted verse text has any line that
would open a new block (`#`, `-`, ```` ``` ````) escaped so a translation's formatting cannot
break your note's structure. YAML scalars are quoted whenever a bare value would be reinterpreted
as a boolean, null or number.
