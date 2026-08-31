/**
 * Redacted diagnostic logging and a small in-memory ring buffer.
 *
 * Nothing reaches the console or the buffer without passing through the
 * redaction layer first. There is no telemetry: the buffer lives in memory,
 * is never written to disk, and never leaves the device unless the user
 * explicitly copies a diagnostics report.
 */
import { redactError, redactString, redactUrl } from "../security/redact";

export interface LogEntry {
  at: string;
  level: "info" | "warn" | "error";
  message: string;
}

/** Redacted record of one HTTP attempt. Holds status codes, never bodies. */
export interface RequestRecord {
  at: string;
  url: string;
  status: number | null;
  attempt: number;
}

const MAX_LOG_ENTRIES = 200;
const MAX_REQUEST_RECORDS = 100;

export class DiagnosticLogger {
  private entries: LogEntry[] = [];
  private requests: RequestRecord[] = [];

  constructor(private enabled: boolean) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  info(message: string): void {
    this.push("info", message);
  }

  warn(message: string): void {
    this.push("warn", message);
  }

  error(message: unknown): void {
    this.push("error", redactError(message));
  }

  /** Record one HTTP attempt. Called from the resilient HTTP client. */
  recordRequest(info: { url: string; status: number | null; attempt: number }): void {
    this.requests.push({
      at: new Date().toISOString(),
      url: redactUrl(info.url),
      status: info.status,
      attempt: info.attempt,
    });
    if (this.requests.length > MAX_REQUEST_RECORDS) this.requests.shift();
    if (this.enabled) {
      // eslint-disable-next-line no-console
      console.warn(`[youversion-sync] ${info.status ?? "network-error"} ${redactUrl(info.url)}`);
    }
  }

  recentRequests(limit = 20): RequestRecord[] {
    return this.requests.slice(-limit);
  }

  recentEntries(limit = 40): LogEntry[] {
    return this.entries.slice(-limit);
  }

  /** Status codes seen this session, with counts. */
  statusCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const record of this.requests) {
      const key = record.status === null ? "network-error" : String(record.status);
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }

  lastSuccessfulOperation(): RequestRecord | null {
    for (let i = this.requests.length - 1; i >= 0; i--) {
      const record = this.requests[i];
      if (record && record.status !== null && record.status >= 200 && record.status < 300)
        return record;
    }
    return null;
  }

  private push(level: LogEntry["level"], message: string): void {
    const entry: LogEntry = { at: new Date().toISOString(), level, message: redactString(message) };
    this.entries.push(entry);
    if (this.entries.length > MAX_LOG_ENTRIES) this.entries.shift();
    if (this.enabled) {
      // eslint-disable-next-line no-console
      console.warn(`[youversion-sync] ${entry.message}`);
    }
  }
}
