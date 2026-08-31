/**
 * User-export provider.
 *
 * Researched on 2026-08-30: YouVersion publishes no official account-data
 * export or downloadable archive for Bible App user data. The developer
 * documentation covers only the Platform API, and the Platform Portal offers
 * app registration and licence management, not a per-user data export. There
 * is therefore no documented file format for this provider to parse.
 *
 * Rather than inventing a format, the provider stays present but unusable, and
 * the "Import official data export" command explains the situation. The parsing
 * seam below is real: if YouVersion ships an export, only `parseExport` and its
 * schema need to be written, and the sync engine is unchanged.
 *
 * See docs/api-research.md for the search performed and what was checked.
 */
import { Capability, HighlightItem } from "../models/domain";
import { CAPABILITIES } from "./capabilities";
import { HighlightSource, Provider } from "./types";

export const NO_EXPORT_MESSAGE =
  "YouVersion does not currently offer an official account-data export or downloadable archive " +
  "for Bible App user data, so there is no supported file for this command to read. If that " +
  "changes, this command will parse the official format locally - the file would never leave " +
  "your device.";

/** Shape a future export parser must produce. Kept so the seam stays honest. */
export interface ParsedExport {
  highlights: HighlightItem[];
  /** Formats we recognised but could not fully interpret, for user feedback. */
  warnings: string[];
}

export class UserExportProvider implements Provider {
  readonly id = "user-export" as const;
  readonly displayName = "Official YouVersion data export";
  readonly capabilities: readonly Capability[] = CAPABILITIES;

  async availability(): Promise<{ usable: boolean; reason: string }> {
    return { usable: false, reason: NO_EXPORT_MESSAGE };
  }

  highlights(): HighlightSource | null {
    return null;
  }

  /**
   * Parse an export archive. Unimplemented on purpose: no official format
   * exists to parse. Throws rather than silently returning nothing, so a future
   * caller cannot mistake "not implemented" for "the export was empty".
   */
  async parseExport(_contents: ArrayBuffer, _filename: string): Promise<ParsedExport> {
    throw new Error(NO_EXPORT_MESSAGE);
  }
}
