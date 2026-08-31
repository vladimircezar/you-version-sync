/**
 * Placeholder for a possible future experimental connector.
 *
 * Intentionally inert. It exists so the provider seam is visible and so the
 * settings tab can state plainly that no such connector is implemented - not
 * as a stub waiting to be filled in.
 *
 * Any real implementation would mean using undocumented endpoints, and that is
 * out of scope by design: it requires a separate, explicit decision and a
 * security review before a line of it is written. This file deliberately
 * contains no endpoints, no request code and no credentials handling, and it is
 * isolated from the official provider so that deleting it entirely cannot
 * affect official highlight sync.
 */
import { Capability } from "../models/domain";
import { CAPABILITIES } from "./capabilities";
import { HighlightSource, Provider } from "./types";

export const EXPERIMENTAL_STATUS =
  "Not implemented. YouVersion does not officially expose these data types, and reaching them " +
  "would mean using undocumented endpoints - which requires a separate decision and a security " +
  "review before any of it is written.";

export class ExperimentalProvider implements Provider {
  readonly id = "experimental" as const;
  readonly displayName = "Experimental connector";
  readonly capabilities: readonly Capability[] = CAPABILITIES;

  async availability(): Promise<{ usable: boolean; reason: string }> {
    return { usable: false, reason: EXPERIMENTAL_STATUS };
  }

  highlights(): HighlightSource | null {
    return null;
  }
}
