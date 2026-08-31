/**
 * Settings model, defaults and the settings tab.
 *
 * The tab is written to be honest about capability: data types YouVersion does
 * not expose appear as disabled rows with the reason, rather than being hidden
 * (which would look like a bug) or shown as togglable (which would be a lie).
 */
import { App, ButtonComponent, Modal, Notice, PluginSettingTab, Setting } from "obsidian";
import type YouVersionSyncPlugin from "./main";
import { MIN_AUTO_SYNC_MINUTES } from "./constants";
import { CAPABILITIES } from "./providers/capabilities";
import { EXPERIMENTAL_STATUS } from "./providers/experimental";
import type { TokenPersistence } from "./auth/tokenStore";

export type HighlightOrganization = "verse" | "chapter";
export type ConflictPolicy = "preserve" | "overwrite" | "skip";
export type RemovalPolicy = "mark" | "archive" | "ignore";
export type ScanScope = "whole" | "new_testament" | "old_testament" | "books";

export interface YouVersionSyncSettings {
  /** The `app_key` from the YouVersion Platform Portal. Not a secret in the OAuth sense. */
  appKey: string;
  /** Loopback port for the OAuth redirect. Must match the registered callback URL. */
  callbackPort: number;

  destinationRoot: string;
  bibleId: number;
  /** Cached abbreviation for display; refreshed from the API on sync. */
  bibleAbbreviation: string;

  syncOnStartup: boolean;
  /** Minutes between automatic syncs. `0` means manual only. */
  autoSyncIntervalMinutes: number;

  importHighlights: boolean;

  /** Which part of the Bible the chapter scan covers. */
  scanScope: ScanScope;
  /** USFM book ids, used when `scanScope` is `books`. */
  scanBooks: string[];

  highlightOrganization: HighlightOrganization;
  downloadVerseText: boolean;
  conflictPolicy: ConflictPolicy;
  removalPolicy: RemovalPolicy;

  diagnosticLogging: boolean;
  tokenPersistence: TokenPersistence;

  /** Display-only, captured from the verified id_token at connect time. */
  accountDisplayName: string;
}

export const DEFAULT_SETTINGS: YouVersionSyncSettings = {
  appKey: "",
  callbackPort: 51789,

  destinationRoot: "Sources/YouVersion",
  // 3034 = Berean Standard Bible, the id used throughout the YouVersion docs.
  bibleId: 3034,
  bibleAbbreviation: "",

  syncOnStartup: false,
  autoSyncIntervalMinutes: 0,

  importHighlights: true,

  scanScope: "new_testament",
  scanBooks: [],

  highlightOrganization: "verse",
  downloadVerseText: false,
  conflictPolicy: "preserve",
  removalPolicy: "mark",

  diagnosticLogging: false,
  tokenPersistence: "disk",

  accountDisplayName: "",
};

/** Coerce persisted data into a valid settings object, dropping unknown junk. */
export function normalizeSettings(raw: unknown): YouVersionSyncSettings {
  const input = (raw && typeof raw === "object" ? raw : {}) as Partial<YouVersionSyncSettings>;
  const merged = { ...DEFAULT_SETTINGS, ...input };

  return {
    ...merged,
    appKey: String(merged.appKey ?? "").trim(),
    callbackPort: clampPort(merged.callbackPort),
    destinationRoot: String(merged.destinationRoot || DEFAULT_SETTINGS.destinationRoot).replace(
      /^\/+|\/+$/g,
      "",
    ),
    bibleId:
      Number.isInteger(merged.bibleId) && merged.bibleId > 0
        ? merged.bibleId
        : DEFAULT_SETTINGS.bibleId,
    autoSyncIntervalMinutes: clampInterval(merged.autoSyncIntervalMinutes),
    scanBooks: Array.isArray(merged.scanBooks)
      ? merged.scanBooks.filter((b) => typeof b === "string")
      : [],
  };
}

function clampPort(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1024 || n > 65535) return DEFAULT_SETTINGS.callbackPort;
  return n;
}

/**
 * `0` (manual) is always allowed. Any automatic interval is floored at
 * MIN_AUTO_SYNC_MINUTES: one sync is a full chapter scan, and running it more
 * often than that would be abusive regardless of what the user asks for.
 */
export function clampInterval(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(MIN_AUTO_SYNC_MINUTES, Math.round(n));
}

export function redirectUri(settings: YouVersionSyncSettings): string {
  return `http://localhost:${settings.callbackPort}/callback`;
}

/** Simple yes/no gate for destructive actions. */
class ConfirmModal extends Modal {
  private confirmed = false;

  constructor(
    app: App,
    private readonly title: string,
    private readonly body: string,
    private readonly confirmLabel: string,
    private readonly onConfirm: () => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText(this.title);
    this.contentEl.createEl("p", { text: this.body });
    const row = this.contentEl.createDiv({ cls: "modal-button-container" });
    new ButtonComponent(row).setButtonText("Cancel").onClick(() => this.close());
    new ButtonComponent(row)
      .setButtonText(this.confirmLabel)
      .setWarning()
      .onClick(() => {
        this.confirmed = true;
        this.close();
      });
  }

  override onClose(): void {
    this.contentEl.empty();
    if (this.confirmed) this.onConfirm();
  }
}

export class YouVersionSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: YouVersionSyncPlugin,
  ) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.renderConnection(containerEl);
    this.renderCredentials(containerEl);
    this.renderDestination(containerEl);
    this.renderDataTypes(containerEl);
    this.renderSyncBehaviour(containerEl);
    this.renderDiagnostics(containerEl);
    this.renderDangerZone(containerEl);
  }

  private get settings(): YouVersionSyncSettings {
    return this.plugin.settings;
  }

  private async save(): Promise<void> {
    await this.plugin.saveSettings();
  }

  private renderConnection(el: HTMLElement): void {
    // No heading on the first group: the guidelines put general settings at the
    // top of the tab without one.
    const connected = this.plugin.tokens.isConnected();
    const granted = this.plugin.tokens.grantedPermissions();
    const status = !connected
      ? "Not connected."
      : granted.includes("highlights")
        ? "Connected. The highlights permission has been granted."
        : this.plugin.tokens.permissionsKnown()
          ? "Connected, but YouVersion reported that the highlights permission was not granted. " +
            "Check your app's permissions in the Platform Portal, then reconnect."
          : "Connected. YouVersion did not report which permissions were granted; the first sync " +
            "will confirm.";

    const setting = new Setting(el).setName("Status").setDesc(status);

    if (connected && this.settings.accountDisplayName) {
      setting.setDesc(`${status} Signed in as ${this.settings.accountDisplayName}.`);
    }

    setting.addButton((btn) =>
      btn
        .setButtonText(connected ? "Reconnect" : "Connect account")
        .setCta()
        .onClick(async () => {
          await this.plugin.connectAccount();
          this.display();
        }),
    );

    if (connected) {
      setting.addButton((btn) =>
        btn.setButtonText("Disconnect").onClick(async () => {
          await this.plugin.disconnectAccount();
          this.display();
        }),
      );
    }

    new Setting(el)
      .setName("Sync now")
      .setDesc("Run a highlight sync immediately using the settings below.")
      .addButton((btn) =>
        btn
          .setButtonText("Sync now")
          .setDisabled(!connected)
          .onClick(() => {
            void this.plugin.runSync("manual");
          }),
      );
  }

  private renderCredentials(el: HTMLElement): void {
    new Setting(el).setName("YouVersion application").setHeading();

    el.createEl("p", {
      cls: "setting-item-description",
      text:
        "Register an application at platform.youversion.com to obtain an App Key, and set its " +
        "callback URL to exactly the redirect URI shown below.",
    });

    new Setting(el)
      .setName("App Key")
      .setDesc("Used as the OAuth client_id and sent as the X-YVP-App-Key header.")
      .addText((text) =>
        text
          .setPlaceholder("Paste your App Key")
          .setValue(this.settings.appKey)
          .onChange(async (value) => {
            this.settings.appKey = value.trim();
            await this.save();
          }),
      );

    new Setting(el)
      .setName("Redirect URI")
      .setDesc(
        "Register this exact URL as your app's callback URL in the Platform Portal. It must " +
          "match character for character - not 127.0.0.1, no trailing slash, no https.",
      )
      .addText((text) => {
        text.setValue(redirectUri(this.settings)).setDisabled(true);
        text.inputEl.addClass("youversion-sync-redirect-uri");
        return text;
      })
      .addButton((btn) =>
        btn
          .setButtonText("Copy")
          .setCta()
          .onClick(async () => {
            await navigator.clipboard.writeText(redirectUri(this.settings));
            new Notice("Redirect URI copied. Paste it into your app's callback URL.");
          }),
      );

    new Setting(el)
      .setName("Callback port")
      .setDesc("Change this only if the port is already in use, then re-register the URI above.")
      .addText((text) =>
        text.setValue(String(this.settings.callbackPort)).onChange(async (value) => {
          this.settings.callbackPort = clampPortInput(value, this.settings.callbackPort);
          await this.save();
          this.display();
        }),
      );

    new Setting(el)
      .setName("Token storage")
      .setDesc(
        "Obsidian provides no OS keychain to plugins. 'This device' writes tokens to the plugin's " +
          "data.json in plain text; 'Session only' keeps them in memory and requires reconnecting " +
          "after each restart. See docs/privacy-and-security.md.",
      )
      .addDropdown((dd) =>
        dd
          .addOption("disk", "This device (data.json)")
          .addOption("session", "Session only (memory)")
          .setValue(this.settings.tokenPersistence)
          .onChange(async (value) => {
            this.settings.tokenPersistence = value as TokenPersistence;
            this.plugin.tokens.setPersistence(this.settings.tokenPersistence);
            await this.save();
          }),
      );
  }

  private renderDestination(el: HTMLElement): void {
    new Setting(el).setName("Destination").setHeading();

    new Setting(el)
      .setName("Destination root folder")
      .setDesc("Folder in this vault that imported YouVersion data is written to.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.destinationRoot)
          .setValue(this.settings.destinationRoot)
          .onChange(async (value) => {
            this.settings.destinationRoot =
              value.replace(/^\/+|\/+$/g, "").trim() || DEFAULT_SETTINGS.destinationRoot;
            await this.save();
          }),
      );

    new Setting(el)
      .setName("Preferred Bible version")
      .setDesc(
        "Numeric YouVersion version id. Highlights are stored per version, so changing this " +
          "starts a separate set of notes rather than replacing the existing ones.",
      )
      .addText((text) =>
        text.setValue(String(this.settings.bibleId)).onChange(async (value) => {
          const n = Number(value);
          if (Number.isInteger(n) && n > 0) {
            this.settings.bibleId = n;
            await this.save();
          }
        }),
      );

    new Setting(el)
      .setName("Download verse text")
      .setDesc(
        "Store scripture text in your notes. Off by default: many translations are licensed in a " +
          "way that does not permit redistribution or local storage. Only enable it for versions " +
          "whose licence you have accepted in the Platform Portal.",
      )
      .addToggle((t) =>
        t.setValue(this.settings.downloadVerseText).onChange(async (value) => {
          this.settings.downloadVerseText = value;
          await this.save();
        }),
      );
  }

  private renderDataTypes(el: HTMLElement): void {
    new Setting(el).setName("Data types").setHeading();

    el.createEl("p", {
      cls: "setting-item-description",
      text:
        "Highlights are the only user data YouVersion's public API exposes. The rows below are " +
        "disabled because no endpoint and no permission exist for them - not because the plugin " +
        "is unfinished. To get that data out of YouVersion today, request a copy of your account " +
        "data from Life.Church directly; if you obtain an export file, the import command can be " +
        "taught to read it.",
    });

    for (const capability of CAPABILITIES) {
      const setting = new Setting(el)
        .setName(titleCase(capability.dataType))
        .setDesc(capability.reason);
      if (capability.state === "available") {
        setting.addToggle((t) =>
          t.setValue(this.settings.importHighlights).onChange(async (value) => {
            this.settings.importHighlights = value;
            await this.save();
          }),
        );
      } else {
        setting.addToggle((t) => t.setValue(false).setDisabled(true));
      }
    }

    new Setting(el)
      .setName("Experimental connector")
      .setDesc(EXPERIMENTAL_STATUS)
      .addToggle((t) => t.setValue(false).setDisabled(true));
  }

  private renderSyncBehaviour(el: HTMLElement): void {
    new Setting(el).setName("Sync").setHeading();

    el.createEl("p", {
      cls: "setting-item-description",
      text:
        "The API can only answer 'is this passage highlighted?', so a sync walks the chapters in " +
        "the scope below. A narrower scope means a much faster, lighter sync.",
    });

    new Setting(el)
      .setName("Scan scope")
      .setDesc("How much of the Bible each sync walks.")
      .addDropdown((dd) =>
        dd
          .addOption("new_testament", "New Testament (~260 chapters)")
          .addOption("old_testament", "Old Testament (~929 chapters)")
          .addOption("whole", "Whole Bible (~1,189 chapters)")
          .addOption("books", "Selected books only")
          .setValue(this.settings.scanScope)
          .onChange(async (value) => {
            this.settings.scanScope = value as ScanScope;
            await this.save();
            this.display();
          }),
      );

    if (this.settings.scanScope === "books") {
      new Setting(el)
        .setName("Books")
        .setDesc("Comma-separated USFM book ids, e.g. JHN, ROM, PSA.")
        .addText((text) =>
          text
            .setPlaceholder("JHN, ROM, PSA")
            .setValue(this.settings.scanBooks.join(", "))
            .onChange(async (value) => {
              this.settings.scanBooks = value
                .split(",")
                .map((s) => s.trim().toUpperCase())
                .filter(Boolean);
              await this.save();
            }),
        );
    }

    new Setting(el)
      .setName("Highlight organization")
      .setDesc("One note per highlighted verse, or one note per chapter collecting its highlights.")
      .addDropdown((dd) =>
        dd
          .addOption("verse", "One note per verse")
          .addOption("chapter", "One note per chapter")
          .setValue(this.settings.highlightOrganization)
          .onChange(async (value) => {
            this.settings.highlightOrganization = value as HighlightOrganization;
            await this.save();
          }),
      );

    new Setting(el).setName("Sync on startup").addToggle((t) =>
      t.setValue(this.settings.syncOnStartup).onChange(async (value) => {
        this.settings.syncOnStartup = value;
        await this.save();
      }),
    );

    new Setting(el)
      .setName("Automatic sync interval")
      .setDesc(
        `Minutes between automatic syncs. 0 means manual only. Minimum ${MIN_AUTO_SYNC_MINUTES} when enabled.`,
      )
      .addText((text) =>
        text.setValue(String(this.settings.autoSyncIntervalMinutes)).onChange(async (value) => {
          this.settings.autoSyncIntervalMinutes = clampInterval(value);
          await this.save();
          this.plugin.rescheduleAutoSync();
        }),
      );

    new Setting(el)
      .setName("Conflict policy")
      .setDesc("What to do when you have edited inside a sync-managed region.")
      .addDropdown((dd) =>
        dd
          .addOption("preserve", "Keep my edit, save theirs alongside (recommended)")
          .addOption("skip", "Keep my edit, skip the note")
          .addOption("overwrite", "Replace the managed region")
          .setValue(this.settings.conflictPolicy)
          .onChange(async (value) => {
            this.settings.conflictPolicy = value as ConflictPolicy;
            await this.save();
          }),
      );

    new Setting(el)
      .setName("Removal policy")
      .setDesc(
        "What to do when a highlight no longer exists in YouVersion. Notes are never deleted.",
      )
      .addDropdown((dd) =>
        dd
          .addOption("mark", "Mark as missing_remote (recommended)")
          .addOption("archive", "Move to the Archive folder")
          .addOption("ignore", "Leave untouched")
          .setValue(this.settings.removalPolicy)
          .onChange(async (value) => {
            this.settings.removalPolicy = value as RemovalPolicy;
            await this.save();
          }),
      );
  }

  private renderDiagnostics(el: HTMLElement): void {
    new Setting(el).setName("Diagnostics").setHeading();

    new Setting(el)
      .setName("Diagnostic logging")
      .setDesc(
        "Log redacted request outcomes to the developer console. Never logs tokens or note content.",
      )
      .addToggle((t) =>
        t.setValue(this.settings.diagnosticLogging).onChange(async (value) => {
          this.settings.diagnosticLogging = value;
          this.plugin.logger.setEnabled(value);
          await this.save();
        }),
      );

    new Setting(el)
      .setName("Sanitized diagnostics")
      .setDesc(
        "Copy a redacted report for bug reports. Contains no tokens, emails or note content.",
      )
      .addButton((btn) =>
        btn.setButtonText("Copy sanitized diagnostics").onClick(async () => {
          await navigator.clipboard.writeText(this.plugin.buildDiagnosticsReport());
          new Notice("Sanitized diagnostics copied to the clipboard.");
        }),
      );

    new Setting(el)
      .setName("Rebuild generated indexes")
      .setDesc(
        "Regenerate Dashboard.md and the index notes from the item notes already in your vault.",
      )
      .addButton((btn) =>
        btn.setButtonText("Rebuild").onClick(() => {
          void this.plugin.rebuildIndexes();
        }),
      );
  }

  private renderDangerZone(el: HTMLElement): void {
    new Setting(el).setName("Danger zone").setHeading();

    new Setting(el)
      .setName("Delete locally imported YouVersion data")
      .setDesc(
        `Deletes every note the plugin created under "${this.settings.destinationRoot}" and clears ` +
          "sync state. Your YouVersion account is not touched. This cannot be undone.",
      )
      .addButton((btn) =>
        btn
          .setButtonText("Delete local data")
          .setWarning()
          .onClick(() => {
            new ConfirmModal(
              this.app,
              "Delete locally imported YouVersion data?",
              `This permanently deletes notes the plugin created under "${this.settings.destinationRoot}" ` +
                "and resets sync state. Notes you created yourself are left alone. Nothing in your " +
                "YouVersion account is changed.",
              "Delete local data",
              () => {
                void this.plugin.deleteLocalData();
              },
            ).open();
          }),
      );
  }
}

function clampPortInput(value: string, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : fallback;
}

function titleCase(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}s`;
}
