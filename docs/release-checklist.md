# Release checklist

## 1. Compliance review

Re-read these before every release; they change without notice.

- [ ] **YouVersion Platform terms** — <https://platform.youversion.com/?tos=1>. Confirm the plugin
      remains within the non-commercial use terms.
- [ ] **YouVersion privacy policy** — <https://www.bible.com/privacy>
- [ ] **Brand and attribution requirements** — confirm how YouVersion may be named and whether any
      attribution is required in the UI or in generated notes.
- [ ] **Rate limits** — still unpublished? If a numeric limit is announced, adjust
      `DEFAULT_RETRY_POLICY` and `MIN_AUTO_SYNC_MINUTES` and say so in the README.
- [ ] **Bible translation licensing** — verse-text download stays off by default. Confirm the
      publisher `copyright` string is still stored with any downloaded text.
- [ ] **Capability matrix** — re-run the research in `docs/api-research.md`. If `notes`,
      `bookmarks` or a plan permission has appeared, update `src/providers/capabilities.ts`, the
      research doc and the README together.
- [ ] **Obsidian community plugin requirements** —
      <https://docs.obsidian.md/Plugins/Releasing/Submission+requirements+for+plugins>

## 2. Obsidian plugin guidelines

Checked against [Plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines),
[Developer policies](https://docs.obsidian.md/Community+directory/Developer+policies) and
[Submission requirements](https://docs.obsidian.md/Community+directory/Submission+requirements+for+plugins).

- [ ] Vault API used throughout; no `vault.adapter`, no `FileSystemAdapter` cast
      (`grep -rn "vault.adapter\|FileSystemAdapter" src/` returns nothing)
- [ ] `Vault.process()` for every read-modify-write; no `Vault.modify()`
- [ ] Deletions go through `fileManager.trashFile`, never `vault.delete`
- [ ] `normalizePath()` applied to every constructed path
- [ ] `this.app`, never the global `app`
- [ ] No `innerHTML` / `outerHTML` / `insertAdjacentHTML`
- [ ] Settings tab: first group has no heading; no heading contains the word "settings";
      `setHeading()` rather than `<h1>`/`<h2>`; sentence case throughout
- [ ] Command IDs contain no plugin id (Obsidian prefixes them); no default hotkeys
- [ ] Timers registered with `registerInterval`; nothing leaks on unload
- [ ] `manifest.json`: description is an action statement, under 250 chars, ends with a period,
      no emoji; `minAppVersion` real; `fundingUrl` absent (no donations); no placeholder `authorUrl`
- [ ] `isDesktopOnly: true` while any Node/Electron API is used
- [ ] No sample-plugin boilerplate left
- [ ] README carries the required disclosures: account required, network use and which hosts,
      no telemetry, no payment
- [ ] LICENSE present; Obsidian and YouVersion trademarks not used misleadingly

## 3. Code and behaviour

- [ ] Still read-only: no `POST` or `DELETE` against YouVersion anywhere
      (`grep -rnE '"(POST|DELETE)"' src/` should only find the OAuth token POST)
- [ ] No undocumented endpoints
- [ ] `isDesktopOnly` still matches reality
- [ ] No telemetry
- [ ] Every user-visible claim about capability matches `capabilities.ts`

## 4. Verification

```bash
npm run verify   # format:check, lint, typecheck, test, build
```

- [ ] Prettier clean
- [ ] ESLint clean, no new `any`
- [ ] `tsc --noEmit` clean under strict mode
- [ ] All tests pass
- [ ] Production build succeeds

## 5. Bundle audit

```bash
# No secrets or tokens
grep -oE 'eyJ[A-Za-z0-9_-]{10,}' main.js

# Only the expected external module
grep -oE 'require\("[^"]+"\)' main.js | sort -u        # expect: require("obsidian")

# Only the expected host
grep -oE 'https://[a-z0-9.-]+\.[a-z]{2,}' main.js | sort -u

# Dependency surface
npm ls --omit=dev --depth=1
```

- [ ] No JWTs, keys or tokens in `main.js`
- [ ] Only `obsidian` is required externally (plus the dynamic `import("node:http")`)
- [ ] Only `api.youversion.com` and `bible.com` appear
- [ ] Production dependencies are just `zod`
- [ ] Bundle size is reasonable (~120 KB)

## 6. Secret scan

```bash
npx --yes gitleaks detect --no-banner 2>/dev/null || echo "install gitleaks"
git ls-files | xargs grep -lE 'eyJ[A-Za-z0-9_-]{20,}' || echo "clean"
grep -rn "app_key\|appKey" tests/ | grep -v "test-app-key\|app-key-123\|opts.appKey"
```

- [ ] No credentials committed
- [ ] `data.json` is gitignored and untracked
- [ ] No real account data in fixtures — fixtures are hand-written (`tests/fixtures/`)
- [ ] No real App Key in tests, docs or CI

## 7. Manual testing

- [ ] `docs/manual-testing.md` completed against a real developer account
- [ ] Step 5 (chapter-level highlights query) explicitly verified
- [ ] Results recorded, with date and versions
- [ ] Anything contradicting `docs/api-research.md` written back into it

## 8. Documentation

- [ ] README's supported/unsupported list matches the code
- [ ] `docs/api-research.md` re-verified, access date updated
- [ ] Open questions still accurate — resolved ones moved out
- [ ] Token-storage limitation still described accurately
- [ ] Mobile status accurate; mobile support not claimed

## 9. Version bump

- [ ] `manifest.json` version
- [ ] `package.json` version
- [ ] `versions.json` maps the new version to its `minAppVersion`
- [ ] All three agree
- [ ] Changelog entry

## 10. Release

- [ ] Tag matches the manifest version exactly, with **no** `v` prefix
- [ ] Release contains `main.js`, `manifest.json` and `styles.css`
- [ ] Attached as individual files, not only a zip
- [ ] Release notes state what is and is not supported

## 11. First submission only

- [ ] `LICENSE` present
- [ ] README explains the App Key requirement up front
- [ ] Plugin id `youversion-sync` is unique in the community list
- [ ] Description does not imply notes/bookmarks/plans support
- [ ] PR opened against `obsidianmd/obsidian-releases`
