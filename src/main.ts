/**
 * YouVersion Sync - plugin entry point.
 *
 * Read-only in this release: nothing here creates, modifies or deletes anything
 * in a user's YouVersion account. The only write paths are into the vault, and
 * the only network calls are the documented GET endpoints plus the OAuth token
 * exchange.
 */
import { ButtonComponent, Modal, Notice, Platform, Plugin, Setting, requestUrl } from "obsidian";

import {
  DEFAULT_SETTINGS,
  YouVersionSettingTab,
  YouVersionSyncSettings,
  normalizeSettings,
  redirectUri,
} from "./settings";
import { AUTH_ENDPOINTS, HIGHLIGHTS_PERMISSION, scanScopeLabel } from "./constants";
import { HttpRequest, HttpResponse, ResilientHttp, Transport } from "./sync/http";
import { OAuthClient, buildAuthorizeUrl } from "./auth/oauth";
import { PersistedTokens, TokenStore } from "./auth/tokenStore";
import { SyncState, emptySyncState } from "./models/domain";
import { createPkcePair, generateNonce, generateState } from "./auth/pkce";
import { startLoopbackReceiver } from "./auth/loopback";
import { verifyJwt } from "./auth/jwt";
import { OfficialApiProvider } from "./providers/officialApi";
import { UserExportProvider } from "./providers/userExport";
import { SyncEngine } from "./sync/engine";
import { CancelledError } from "./sync/rateLimit";
import { ObsidianVaultIO, VaultIO } from "./markdown/vaultIo";
import { DashboardContext, collectHighlightEntries, rebuildAllIndexes } from "./markdown/indexes";
import { FOLDERS, joinPath } from "./markdown/paths";
import { DiagnosticLogger } from "./diagnostics/logger";
import { buildDiagnostics } from "./diagnostics/report";
import { redactError } from "./security/redact";
import { formatProbeReport, probeHighlightAccess } from "./diagnostics/probe";

interface PluginData {
  settings: YouVersionSyncSettings;
  syncState: SyncState;
  tokens: PersistedTokens | null;
}

const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;

export default class YouVersionSyncPlugin extends Plugin {
  override settings: YouVersionSyncSettings = { ...DEFAULT_SETTINGS };
  syncState: SyncState = emptySyncState();
  logger!: DiagnosticLogger;
  tokens!: TokenStore;

  private io!: VaultIO;
  private http!: ResilientHttp;
  private oauth!: OAuthClient;
  private readonly userExport = new UserExportProvider();

  private statusBar: HTMLElement | null = null;
  private autoSyncTimer: number | null = null;
  private activeSync: AbortController | null = null;
  private persistedTokens: PersistedTokens | null = null;

  override async onload(): Promise<void> {
    await this.loadPluginData();

    this.logger = new DiagnosticLogger(this.settings.diagnosticLogging);
    this.io = new ObsidianVaultIO(this.app);

    this.http = new ResilientHttp({
      transport: obsidianTransport,
      onAttempt: (info) => this.logger.recordRequest(info),
    });

    this.tokens = new TokenStore({
      persistence: this.settings.tokenPersistence,
      load: async () => this.persistedTokens,
      save: async (payload) => {
        this.persistedTokens = payload;
        await this.savePluginData();
      },
    });
    await this.tokens.hydrate();

    this.oauth = new OAuthClient(this.oauthConfig(), this.http);

    this.addSettingTab(new YouVersionSettingTab(this.app, this));
    this.registerCommands();

    this.statusBar = this.addStatusBarItem();
    this.updateStatusBar();

    this.addRibbonIcon("book-open", "YouVersion Sync: sync now", () => {
      void this.runSync("manual");
    });

    this.rescheduleAutoSync();

    if (this.settings.syncOnStartup) {
      // Defer until the workspace is ready so a sync never competes with startup.
      this.app.workspace.onLayoutReady(() => {
        void this.runSync("startup");
      });
    }
  }

  override onunload(): void {
    this.cancelSync();
    if (this.autoSyncTimer !== null) window.clearInterval(this.autoSyncTimer);
  }

  // --- Commands -----------------------------------------------------------

  private registerCommands(): void {
    this.addCommand({
      id: "connect-account",
      name: "Connect account",
      callback: () => {
        void this.connectAccount();
      },
    });

    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => {
        void this.runSync("manual");
      },
    });

    this.addCommand({
      id: "import-export",
      name: "Import official data export",
      callback: () => {
        void this.importOfficialExport();
      },
    });

    this.addCommand({
      id: "show-status",
      name: "Show sync status",
      callback: () => {
        void this.showSyncStatus();
      },
    });

    this.addCommand({
      id: "rebuild-indexes",
      name: "Rebuild generated indexes",
      callback: () => {
        void this.rebuildIndexes();
      },
    });

    this.addCommand({
      id: "disconnect-account",
      name: "Disconnect account",
      callback: () => {
        void this.disconnectAccount();
      },
    });

    this.addCommand({
      id: "diagnose-highlights",
      name: "Diagnose highlight access",
      callback: () => {
        void this.diagnoseHighlights();
      },
    });

    this.addCommand({
      id: "cancel-sync",
      name: "Cancel running sync",
      checkCallback: (checking) => {
        if (checking) return this.activeSync !== null;
        this.cancelSync();
        return true;
      },
    });
  }

  // --- Authentication -----------------------------------------------------

  /**
   * Run the three-hop authorization-code flow with PKCE.
   *
   * Desktop only: the flow terminates on a loopback listener, which needs
   * `node:http`. Mobile support is deliberately not claimed - see
   * docs/architecture.md ("Mobile").
   */
  async connectAccount(): Promise<void> {
    if (!Platform.isDesktopApp) {
      new Notice(
        "Connecting requires Obsidian on desktop. The OAuth redirect needs a local listener, " +
          "which mobile Obsidian does not provide.",
        10000,
      );
      return;
    }

    if (!this.settings.appKey) {
      new Notice("Add your YouVersion App Key in the plugin settings first.", 8000);
      return;
    }

    const state = generateState();
    const nonce = generateNonce();
    const pkce = await createPkcePair();

    let receiver;
    try {
      receiver = await startLoopbackReceiver({
        port: this.settings.callbackPort,
        path: "/callback",
        replayEndpoint: AUTH_ENDPOINTS.callback,
        expectedState: state,
        timeoutMs: OAUTH_TIMEOUT_MS,
      });
    } catch (err) {
      const message = redactError(err);
      this.logger.error(message);
      new Notice(`YouVersion Sync: ${message}`, 12000);
      return;
    }

    try {
      // Refresh the client in case the App Key or port changed since load.
      this.oauth = new OAuthClient(this.oauthConfig(), this.http);

      const authorizeUrl = buildAuthorizeUrl(this.oauthConfig(), {
        pkce,
        state,
        nonce,
        requestHighlights: true,
      });

      new Notice("Opening YouVersion in your browser to sign in...", 6000);
      window.open(authorizeUrl, "_blank");

      const callback = await receiver.result;
      const tokenSet = await this.oauth.exchangeCode(
        callback.code,
        pkce.verifier,
        callback.grantedPermissions,
      );
      tokenSet.permissionsReported = callback.permissionsReported;

      // The permission list on the callback is authoritative; fall back to
      // querying it if the redirect omitted the parameter entirely.
      if (tokenSet.grantedPermissions.length === 0) {
        tokenSet.grantedPermissions = callback.grantedPermissions;
      }

      await this.tokens.store(tokenSet);
      await this.captureAccountName(nonce);

      if (this.tokens.hasPermission(HIGHLIGHTS_PERMISSION)) {
        new Notice("Connected to YouVersion. The highlights permission was granted.", 5000);
      } else if (callback.permissionsReported) {
        new Notice(
          "Connected, but YouVersion reported that the highlights permission was not granted. " +
            "Check that your app requests the highlights permission in the Platform Portal, " +
            "then reconnect and approve it.",
          15000,
        );
      } else {
        // Silence is not a denial. Say what we know and let the sync proceed.
        new Notice(
          "Connected to YouVersion. It did not report which permissions were granted, so the " +
            "first sync will find out. If highlights were not approved, the sync will say so.",
          12000,
        );
      }

      this.logger.info("OAuth connect completed.");
      this.updateStatusBar();
      await this.savePluginData();
    } catch (err) {
      const message = redactError(err);
      this.logger.error(message);
      new Notice(`YouVersion Sync: ${message}`, 12000);
    } finally {
      await receiver.close();
    }
  }

  /**
   * Read the display name from the id_token, after verifying its signature
   * against the published JWKS. An unverifiable token is simply not trusted for
   * display; it does not block the connection, because the access token's
   * validity is decided by the API, not by us.
   */
  private async captureAccountName(nonce: string): Promise<void> {
    const idToken = this.tokens.peekIdToken();
    if (!idToken) return;

    try {
      const jwks = await this.oauth.fetchJwks();
      const claims = await verifyJwt(idToken, {
        jwks,
        issuer: AUTH_ENDPOINTS.issuer,
        audience: this.settings.appKey,
        nonce,
      });
      // Store the display name only. The email claim is deliberately discarded.
      this.settings.accountDisplayName = claims.name ?? "";
    } catch (err) {
      this.settings.accountDisplayName = "";
      this.logger.warn(`Could not verify the id_token for display purposes: ${redactError(err)}`);
    }
  }

  async disconnectAccount(): Promise<void> {
    await this.tokens.clear();
    this.settings.accountDisplayName = "";
    await this.savePluginData();
    this.updateStatusBar();
    new Notice(
      "Disconnected. Tokens have been discarded locally. To revoke this app's access entirely, " +
        "remove it from your YouVersion account settings.",
      10000,
    );
  }

  // --- Sync ---------------------------------------------------------------

  async runSync(trigger: "manual" | "startup" | "auto"): Promise<void> {
    if (this.activeSync) {
      new Notice("A YouVersion sync is already running.");
      return;
    }
    if (!this.settings.importHighlights) {
      if (trigger === "manual") new Notice("Highlight import is turned off in settings.");
      return;
    }

    const provider = this.buildProvider();
    const availability = await provider.availability();
    if (!availability.usable) {
      if (trigger === "manual") new Notice(`YouVersion Sync: ${availability.reason}`, 10000);
      this.logger.warn(`Sync skipped: ${availability.reason}`);
      return;
    }

    const controller = new AbortController();
    this.activeSync = controller;
    provider.resetRunCaches();

    const notice = new Notice("YouVersion Sync: starting...", 0);
    this.updateStatusBar("syncing");

    try {
      const engine = new SyncEngine({
        io: this.io,
        source: provider.highlights(),
        destinationRoot: this.settings.destinationRoot,
        conflictPolicy: this.settings.conflictPolicy,
        removalPolicy: this.settings.removalPolicy,
        organization: this.settings.highlightOrganization,
        saveState: async (state) => {
          this.syncState = state;
          await this.savePluginData();
        },
        onProgress: (summary, label) => {
          notice.setMessage(
            `YouVersion Sync: ${summary.chaptersScanned}/${summary.chaptersTotal} chapters (${label}) - ` +
              `${summary.created + summary.updated} written`,
          );
        },
      });

      const summary = await engine.run(this.syncState, controller.signal);

      const meta = await provider.bibleMetadata({ signal: controller.signal }).catch(() => null);
      if (meta?.abbreviation) this.settings.bibleAbbreviation = meta.abbreviation;

      await this.rebuildIndexes({ quiet: true });
      await this.savePluginData();

      notice.hide();
      const scope = scanScopeLabel(this.settings.scanScope, this.settings.scanBooks);
      const partial = this.settings.scanScope !== "whole";
      new Notice(
        `YouVersion Sync ${summary.cancelled ? "cancelled" : "finished"}: ` +
          `${summary.created} created, ${summary.updated} updated, ${summary.unchanged} unchanged, ` +
          `${summary.conflicted} conflicts, ${summary.failed} failed.\n` +
          `Scanned ${scope}.` +
          (partial
            ? " Highlights outside that scope were not looked for - widen the scan scope in " +
              "settings to import them."
            : ""),
        partial ? 12000 : 8000,
      );
      this.logger.info(
        `Sync ${summary.cancelled ? "cancelled" : "complete"} (${trigger}): ` +
          `${summary.chaptersScanned}/${summary.chaptersTotal} chapters.`,
      );
    } catch (err) {
      notice.hide();
      if (err instanceof CancelledError) {
        new Notice("YouVersion sync cancelled.");
      } else {
        const message = redactError(err);
        this.logger.error(message);
        new Notice(`YouVersion Sync failed: ${message}`, 12000);
      }
    } finally {
      this.activeSync = null;
      this.updateStatusBar();
    }
  }

  cancelSync(): void {
    this.activeSync?.abort();
  }

  rescheduleAutoSync(): void {
    if (this.autoSyncTimer !== null) {
      window.clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
    const minutes = this.settings.autoSyncIntervalMinutes;
    if (minutes <= 0) return;

    this.autoSyncTimer = window.setInterval(
      () => {
        void this.runSync("auto");
      },
      minutes * 60 * 1000,
    );
    this.registerInterval(this.autoSyncTimer);
  }

  // --- Other commands -----------------------------------------------------

  async importOfficialExport(): Promise<void> {
    const availability = await this.userExport.availability();
    new Notice(`YouVersion Sync: ${availability.reason}`, 15000);
    this.logger.info("Export import requested; no official export format is available.");
  }

  async showSyncStatus(): Promise<void> {
    const entries = await collectHighlightEntries(this.io, this.settings.destinationRoot);
    const summary = this.syncState.lastSummary;
    const connected = this.tokens.isConnected();

    const lines = [
      `Connection: ${connected ? "connected" : "not connected"}`,
      `Highlights in vault: ${entries.length}`,
      `Last successful sync: ${this.syncState.lastSuccessfulSyncAt ?? "never"}`,
    ];
    if (summary) {
      lines.push(
        `Last run: ${summary.created} created, ${summary.updated} updated, ` +
          `${summary.unchanged} unchanged, ${summary.conflicted} conflicts, ${summary.failed} failed`,
      );
    }
    if (this.syncState.cursor) {
      lines.push(`Resumable scan pending at chapter ${this.syncState.cursor.nextChapterIndex}.`);
    }
    lines.push("Notes, bookmarks and reading plans are not available from the official API.");

    new Notice(lines.join("\n"), 15000);
  }

  async rebuildIndexes(options: { quiet?: boolean } = {}): Promise<void> {
    try {
      const ctx: DashboardContext = {
        connected: this.tokens.isConnected(),
        accountDisplayName: this.settings.accountDisplayName,
        providerName: "YouVersion official API",
        lastSuccessfulSyncAt: this.syncState.lastSuccessfulSyncAt,
        lastSummary: this.syncState.lastSummary,
        destinationRoot: this.settings.destinationRoot,
        bibleId: this.settings.bibleId,
        bibleVersion: this.settings.bibleAbbreviation,
        scanScope: scanScopeLabel(this.settings.scanScope, this.settings.scanBooks),
        scopeIsPartial: this.settings.scanScope !== "whole",
      };
      const result = await rebuildAllIndexes(this.io, this.settings.destinationRoot, ctx);
      if (!options.quiet) new Notice(`Rebuilt indexes for ${result.highlights} highlights.`);
    } catch (err) {
      const message = redactError(err);
      this.logger.error(message);
      if (!options.quiet) new Notice(`Could not rebuild indexes: ${message}`, 10000);
    }
  }

  /**
   * Delete only what this plugin generated. A note is removed when its
   * frontmatter says `source: youversion`; anything else in the folder is the
   * user's and is left alone.
   */
  async deleteLocalData(): Promise<void> {
    const root = this.settings.destinationRoot;
    const folders = [
      joinPath(root, FOLDERS.highlights),
      joinPath(root, FOLDERS.notes),
      joinPath(root, FOLDERS.bookmarks),
      joinPath(root, FOLDERS.plans),
      joinPath(root, FOLDERS.indexes),
      joinPath(root, FOLDERS.archive),
      root,
    ];

    let removed = 0;
    let skipped = 0;

    for (const folder of folders) {
      const files = await this.io.listFiles(folder);
      for (const path of files) {
        if (!path.endsWith(".md")) continue;
        try {
          const content = await this.io.read(path);
          if (!/^source:\s*youversion\s*$/m.test(content.split("---")[1] ?? "")) {
            skipped += 1;
            continue;
          }
          await this.io.trash(path);
          removed += 1;
        } catch {
          skipped += 1;
        }
      }
    }

    this.syncState = emptySyncState();
    await this.savePluginData();

    new Notice(
      `Moved ${removed} imported note${removed === 1 ? "" : "s"}.` +
        (skipped > 0
          ? ` Left ${skipped} file${skipped === 1 ? "" : "s"} that the plugin did not create.`
          : ""),
      10000,
    );
  }

  /**
   * Ask about one verse the user knows is highlighted, and report what the API
   * actually says. This is the tool for "the sync found nothing": it separates
   * a wrong Bible version from a chapter-query that does not behave as
   * documented, which need opposite fixes.
   */
  async diagnoseHighlights(): Promise<void> {
    const provider = this.buildProvider({ fastFail: true });
    const availability = await provider.availability();
    if (!this.tokens.isConnected()) {
      new Notice(`YouVersion Sync: ${availability.reason}`, 10000);
      return;
    }

    new PromptModal(
      this.app,
      "Diagnose highlight access",
      "Enter one verse you know you have highlighted, in USFM form, and optionally the Bible " +
        "version it is in. Highlights are stored per version, so testing the right one matters " +
        "more than anything else here. ESV is 59, NIV is 111, BSB is 3034.",
      "JHN.3.16",
      String(this.settings.bibleId),
      async (reference, bibleIdInput) => {
        const bibleId = Number(bibleIdInput) || this.settings.bibleId;
        const notice = new Notice("Probing highlight access...", 0);
        const controller = new AbortController();
        // Never let a diagnostic run unbounded, whatever the network does.
        const guard = window.setTimeout(() => controller.abort(), 60_000);
        try {
          const report = await probeHighlightAccess(provider, reference, bibleId, {
            ctx: { signal: controller.signal },
            onProgress: (done, total, label) => {
              notice.setMessage(`Probing highlight access: ${label} (${done + 1}/${total})`);
            },
          });
          window.clearTimeout(guard);
          notice.hide();
          const text = formatProbeReport(report);
          this.logger.info(`Probe conclusion: ${report.conclusion}`);
          new ResultModal(this.app, "Highlight access probe", text).open();
        } catch (err) {
          window.clearTimeout(guard);
          notice.hide();
          new Notice(`YouVersion Sync: ${redactError(err)}`, 12000);
        }
      },
    ).open();
  }

  /** Bible versions this App Key can see, for the settings picker. */
  async listBibleVersions(
    allAvailable = false,
  ): Promise<Array<{ id: number; abbreviation: string }>> {
    return this.buildProvider({ fastFail: true }).listBibles({}, allAvailable);
  }

  buildDiagnosticsReport(): string {
    const summary = this.syncState.lastSummary;
    const records = Object.values(this.syncState.records);

    return buildDiagnostics({
      pluginVersion: this.manifest.version,
      obsidianVersion: obsidianApiVersion(),
      platform: Platform.isMacOS
        ? "macOS"
        : Platform.isWin
          ? "Windows"
          : Platform.isLinux
            ? "Linux"
            : "other",
      isDesktop: Platform.isDesktopApp,
      providerId: "official-api",
      providerName: "YouVersion official API",
      authState: !this.tokens.isConnected()
        ? "disconnected"
        : this.tokens.isExpired()
          ? "expired"
          : "connected",
      grantedPermissions: this.tokens.grantedPermissions(),
      tokenPersistence: this.settings.tokenPersistence,
      accessTokenExpiresAt: this.tokens.expiresAtIso(),
      appKeyConfigured: this.settings.appKey.length > 0,
      lastSuccessfulSyncAt: this.syncState.lastSuccessfulSyncAt,
      lastSummary: summary,
      itemCounts: {
        highlights: records.length,
        conflicts: records.filter((r) => r.status === "conflict").length,
        missingRemote: records.filter((r) => r.status === "missing_remote").length,
      },
      settingsDigest: {
        destinationRoot: this.settings.destinationRoot,
        bibleId: this.settings.bibleId,
        scanScope: this.settings.scanScope,
        downloadVerseText: this.settings.downloadVerseText,
        conflictPolicy: this.settings.conflictPolicy,
        removalPolicy: this.settings.removalPolicy,
        autoSyncIntervalMinutes: this.settings.autoSyncIntervalMinutes,
      },
      logger: this.logger,
    });
  }

  // --- Plumbing -----------------------------------------------------------

  private oauthConfig() {
    return { appKey: this.settings.appKey, redirectUri: redirectUri(this.settings) };
  }

  private buildProvider(options: { fastFail?: boolean } = {}): OfficialApiProvider {
    // Sync retries hard because it is long-running and unattended. A probe is
    // interactive: one attempt, short backoff, so a bad version costs a moment
    // rather than a minute.
    const http = options.fastFail
      ? new ResilientHttp({
          transport: obsidianTransport,
          // One retry, tightly capped: enough for a transient 429 to clear,
          // never enough to make the user wait or to deepen a real limit.
          policy: { maxAttempts: 2, baseDelayMs: 400, maxDelayMs: 2000, minIntervalMs: 200 },
          onAttempt: (info) => this.logger.recordRequest(info),
        })
      : this.http;

    return new OfficialApiProvider({
      http,
      oauth: this.oauth,
      tokens: this.tokens,
      appKey: this.settings.appKey,
      bibleId: this.settings.bibleId,
      scanScope: { scope: this.settings.scanScope, books: this.settings.scanBooks },
      downloadVerseText: this.settings.downloadVerseText,
    });
  }

  private updateStatusBar(state?: "syncing"): void {
    if (!this.statusBar) return;
    if (state === "syncing") {
      this.statusBar.setText("YouVersion: syncing...");
      return;
    }
    this.statusBar.setText(
      this.tokens.isConnected() ? "YouVersion: connected" : "YouVersion: not connected",
    );
  }

  private async loadPluginData(): Promise<void> {
    const raw = (await this.loadData()) as Partial<PluginData> | null;
    this.settings = normalizeSettings(raw?.settings);
    this.syncState = { ...emptySyncState(), ...(raw?.syncState ?? {}) };
    this.persistedTokens = raw?.tokens ?? null;
  }

  async saveSettings(): Promise<void> {
    this.settings = normalizeSettings(this.settings);
    await this.savePluginData();
  }

  private async savePluginData(): Promise<void> {
    const data: PluginData = {
      settings: this.settings,
      syncState: this.syncState,
      tokens: this.persistedTokens,
    };
    await this.saveData(data);
  }
}

/** Obsidian exposes its API version on `window`, but not in the public typings. */
function obsidianApiVersion(): string {
  const value = (window as unknown as { apiVersion?: unknown }).apiVersion;
  return typeof value === "string" ? value : "unknown";
}

/**
 * Obsidian's `requestUrl` is used instead of `fetch`: it is not subject to the
 * renderer's CORS policy, and it does not attach the vault's cookies.
 */
const obsidianTransport: Transport = async (req: HttpRequest): Promise<HttpResponse> => {
  const response = await requestUrl({
    url: req.url,
    method: req.method,
    headers: req.headers,
    body: req.body,
    contentType: req.contentType,
    throw: false,
  });

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(response.headers ?? {})) {
    headers[key] = String(value);
  }

  return { status: response.status, headers, text: response.text ?? "" };
};

/** Two-field prompt: the verse to test, and which Bible version to test it in. */
class PromptModal extends Modal {
  private value = "";
  private secondValue = "";

  constructor(
    app: import("obsidian").App,
    private readonly heading: string,
    private readonly body: string,
    private readonly placeholder: string,
    private readonly defaultVersion: string,
    private readonly onSubmit: (value: string, version: string) => void | Promise<void>,
  ) {
    super(app);
    this.secondValue = defaultVersion;
  }

  override onOpen(): void {
    this.titleEl.setText(this.heading);
    this.contentEl.createEl("p", { text: this.body });

    new Setting(this.contentEl).setName("Verse (USFM)").addText((text) => {
      text.setPlaceholder(this.placeholder).onChange((v) => {
        this.value = v.trim();
      });
      text.inputEl.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.key === "Enter") this.submit();
      });
      window.setTimeout(() => text.inputEl.focus(), 0);
    });

    new Setting(this.contentEl)
      .setName("Bible version id")
      .setDesc("The version the highlight was made in. Defaults to your configured version.")
      .addText((text) => {
        text.setValue(this.defaultVersion).onChange((v) => {
          this.secondValue = v.trim();
        });
        text.inputEl.addEventListener("keydown", (event: KeyboardEvent) => {
          if (event.key === "Enter") this.submit();
        });
      });

    const row = this.contentEl.createDiv({ cls: "modal-button-container" });
    new ButtonComponent(row).setButtonText("Cancel").onClick(() => this.close());
    new ButtonComponent(row)
      .setButtonText("Run probe")
      .setCta()
      .onClick(() => this.submit());
  }

  private submit(): void {
    const value = this.value || this.placeholder;
    const version = this.secondValue || this.defaultVersion;
    this.close();
    void this.onSubmit(value, version);
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

/** Read-only result view with a copy button. */
class ResultModal extends Modal {
  constructor(
    app: import("obsidian").App,
    private readonly heading: string,
    private readonly text: string,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText(this.heading);
    const pre = this.contentEl.createEl("pre", { cls: "youversion-sync-report" });
    pre.setText(this.text);

    const row = this.contentEl.createDiv({ cls: "modal-button-container" });
    new ButtonComponent(row)
      .setButtonText("Copy")
      .setCta()
      .onClick(async () => {
        await navigator.clipboard.writeText(this.text);
        new Notice("Copied.");
      });
    new ButtonComponent(row).setButtonText("Close").onClick(() => this.close());
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
