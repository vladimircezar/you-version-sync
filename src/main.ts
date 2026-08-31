/**
 * YouVersion Sync - plugin entry point.
 *
 * Read-only in this release: nothing here creates, modifies or deletes anything
 * in a user's YouVersion account. The only write paths are into the vault, and
 * the only network calls are the documented GET endpoints plus the OAuth token
 * exchange.
 */
import { Notice, Platform, Plugin, requestUrl } from "obsidian";

import {
  DEFAULT_SETTINGS,
  YouVersionSettingTab,
  YouVersionSyncSettings,
  normalizeSettings,
  redirectUri,
} from "./settings";
import { AUTH_ENDPOINTS, HIGHLIGHTS_PERMISSION } from "./constants";
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
      new Notice(
        `YouVersion Sync ${summary.cancelled ? "cancelled" : "finished"}: ` +
          `${summary.created} created, ${summary.updated} updated, ${summary.unchanged} unchanged, ` +
          `${summary.conflicted} conflicts, ${summary.failed} failed.`,
        8000,
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

  private buildProvider(): OfficialApiProvider {
    return new OfficialApiProvider({
      http: this.http,
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
