/**
 * What YouVersion actually exposes, verified against the official docs and the
 * published OpenAPI document on 2026-08-30. See docs/api-research.md for the
 * evidence behind every line here.
 *
 * These strings are rendered verbatim in the settings tab and in Dashboard.md.
 * If YouVersion adds a permission, this table and the research doc are the two
 * places that must change first.
 */
import { Capability } from "../models/domain";

export const CAPABILITIES: readonly Capability[] = [
  {
    dataType: "highlight",
    state: "available",
    reason:
      "Supported. Requested via requested_permissions[]=highlights and read from GET /v1/highlights.",
  },
  {
    dataType: "note",
    state: "unavailable",
    reason:
      "Not supported. The sign-in documentation states that notes are not a supported permission, " +
      "and no notes endpoint exists in the published API.",
  },
  {
    dataType: "bookmark",
    state: "unavailable",
    reason:
      "Not supported. The sign-in documentation states that bookmarks are not a supported " +
      "permission, and no bookmarks or saved-verses endpoint exists in the published API.",
  },
  {
    dataType: "plan",
    state: "unavailable",
    reason:
      "Not supported. The public API exposes no reading-plan, subscription or progress endpoint, " +
      "and no plan permission can be requested.",
  },
] as const;

export function capabilityFor(dataType: Capability["dataType"]): Capability {
  const found = CAPABILITIES.find((c) => c.dataType === dataType);
  if (!found) throw new Error(`Unknown data type: ${dataType}`);
  return found;
}

export function unavailableTypes(): readonly Capability[] {
  return CAPABILITIES.filter((c) => c.state === "unavailable");
}
