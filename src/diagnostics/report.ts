/**
 * The sanitized diagnostics report.
 *
 * This is written to be safe to paste into a public issue tracker. It carries
 * versions, platform, connection *state*, status codes and counts - and by
 * construction it cannot carry tokens, cookies, authorization headers, email
 * addresses, note content or highlight text. Every string that originates
 * outside this function is passed through the redaction layer on the way in.
 */
import { CAPABILITIES } from "../providers/capabilities";
import { DiagnosticLogger } from "./logger";
import { SyncSummary } from "../models/domain";
import { redactString } from "../security/redact";

export interface DiagnosticsInput {
  pluginVersion: string;
  obsidianVersion: string;
  platform: string;
  isDesktop: boolean;
  providerId: string;
  providerName: string;
  /** Connection state only. Never a token, never an expiry-bearing secret. */
  authState: "disconnected" | "connected" | "expired";
  grantedPermissions: string[];
  tokenPersistence: string;
  accessTokenExpiresAt: string | null;
  appKeyConfigured: boolean;
  lastSuccessfulSyncAt: string | null;
  lastSummary: SyncSummary | null;
  itemCounts: { highlights: number; conflicts: number; missingRemote: number };
  settingsDigest: {
    destinationRoot: string;
    bibleId: number;
    scanScope: string;
    downloadVerseText: boolean;
    conflictPolicy: string;
    removalPolicy: string;
    autoSyncIntervalMinutes: number;
  };
  logger: DiagnosticLogger;
}

export function buildDiagnostics(input: DiagnosticsInput): string {
  const lines: string[] = [];

  lines.push("YouVersion Sync - sanitized diagnostics");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");

  lines.push("## Environment");
  lines.push(`- Plugin version: ${input.pluginVersion}`);
  lines.push(`- Obsidian version: ${input.obsidianVersion}`);
  lines.push(`- Platform: ${input.platform} (${input.isDesktop ? "desktop" : "mobile"})`);
  lines.push("");

  lines.push("## Provider");
  lines.push(`- Provider: ${input.providerName} (${input.providerId})`);
  lines.push(`- App Key configured: ${input.appKeyConfigured ? "yes" : "no"}`);
  lines.push("");

  lines.push("## Authentication");
  lines.push(`- State: ${input.authState}`);
  lines.push(`- Granted permissions: ${input.grantedPermissions.join(", ") || "(none)"}`);
  lines.push(`- Token storage: ${input.tokenPersistence}`);
  lines.push(`- Access token expires at: ${input.accessTokenExpiresAt ?? "n/a"}`);
  lines.push("- Token values: never included in this report.");
  lines.push("");

  lines.push("## Settings");
  const s = input.settingsDigest;
  lines.push(`- Destination root: ${s.destinationRoot}`);
  lines.push(`- Bible version id: ${s.bibleId}`);
  lines.push(`- Scan scope: ${s.scanScope}`);
  lines.push(`- Download verse text: ${s.downloadVerseText}`);
  lines.push(`- Conflict policy: ${s.conflictPolicy}`);
  lines.push(`- Removal policy: ${s.removalPolicy}`);
  lines.push(`- Auto sync interval (minutes): ${s.autoSyncIntervalMinutes}`);
  lines.push("");

  lines.push("## Sync");
  lines.push(`- Last successful sync: ${input.lastSuccessfulSyncAt ?? "never"}`);
  if (input.lastSummary) {
    const l = input.lastSummary;
    lines.push(`- Last run started: ${l.startedAt}`);
    lines.push(
      `- Last run finished: ${l.finishedAt ?? "did not finish"}${l.cancelled ? " (cancelled)" : ""}`,
    );
    lines.push(`- Chapters scanned: ${l.chaptersScanned}/${l.chaptersTotal}`);
    lines.push(
      `- created=${l.created} updated=${l.updated} unchanged=${l.unchanged} ` +
        `archived=${l.archived} conflicted=${l.conflicted} failed=${l.failed}`,
    );
  }
  lines.push(`- Highlights in vault: ${input.itemCounts.highlights}`);
  lines.push(`- Conflicted notes: ${input.itemCounts.conflicts}`);
  lines.push(`- Marked missing_remote: ${input.itemCounts.missingRemote}`);
  lines.push("");

  lines.push("## HTTP status codes this session");
  const counts = input.logger.statusCounts();
  if (Object.keys(counts).length === 0) {
    lines.push("- (no requests made)");
  } else {
    for (const [status, count] of Object.entries(counts).sort())
      lines.push(`- ${status}: ${count}`);
  }
  const lastOk = input.logger.lastSuccessfulOperation();
  lines.push(`- Last successful API operation: ${lastOk ? `${lastOk.at} ${lastOk.url}` : "none"}`);
  lines.push("");

  lines.push("## Recent requests (redacted URLs)");
  const recent = input.logger.recentRequests(15);
  if (recent.length === 0) lines.push("- (none)");
  for (const record of recent) {
    lines.push(
      `- ${record.at} ${record.status ?? "network-error"} attempt=${record.attempt} ${record.url}`,
    );
  }
  lines.push("");

  lines.push("## Recent messages (redacted)");
  const entries = input.logger.recentEntries(25);
  if (entries.length === 0) lines.push("- (none)");
  for (const entry of entries) lines.push(`- ${entry.at} [${entry.level}] ${entry.message}`);
  lines.push("");

  lines.push("## Capability matrix");
  for (const capability of CAPABILITIES) {
    lines.push(`- ${capability.dataType}: ${capability.state}`);
  }
  lines.push("");

  lines.push(
    "This report intentionally excludes tokens, cookies, authorization headers, email addresses, " +
      "note content and highlight text.",
  );

  // Belt and braces: run the whole report through redaction before returning it,
  // so a future edit to this function cannot introduce a leak silently.
  return redactString(lines.join("\n"));
}
