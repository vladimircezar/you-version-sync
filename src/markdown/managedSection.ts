/**
 * Managed / user region handling.
 *
 * A synced note is split by HTML comment markers into a region the plugin owns
 * and a region the user owns. Sync rewrites only the managed region, and only
 * when it still looks exactly as the plugin last left it. If the user has edited
 * inside the managed markers, that is a conflict — we surface it rather than
 * silently discarding their words.
 */
import { MANAGED_END, MANAGED_START, USER_END, USER_START } from "../constants";

export interface RegionSplit {
  before: string;
  managed: string;
  between: string;
  user: string;
  after: string;
}

export class MissingMarkersError extends Error {
  constructor() {
    super("The note does not contain the expected youversion-sync markers.");
    this.name = "MissingMarkersError";
  }
}

function indexOfRegion(body: string, start: string, end: string): [number, number] | null {
  const s = body.indexOf(start);
  if (s === -1) return null;
  const e = body.indexOf(end, s + start.length);
  if (e === -1) return null;
  return [s, e];
}

/**
 * Split a note body into its regions. Returns `null` when either marker pair is
 * absent, which the caller treats as "not a note we may rewrite".
 */
export function splitRegions(body: string): RegionSplit | null {
  const managedRange = indexOfRegion(body, MANAGED_START, MANAGED_END);
  const userRange = indexOfRegion(body, USER_START, USER_END);
  if (!managedRange || !userRange) return null;

  const [mStart, mEnd] = managedRange;
  const [uStart, uEnd] = userRange;
  // Require the canonical order; anything else is a hand-restructured file.
  if (uStart < mEnd) return null;

  return {
    before: body.slice(0, mStart),
    managed: body.slice(mStart + MANAGED_START.length, mEnd),
    between: body.slice(mEnd + MANAGED_END.length, uStart),
    user: body.slice(uStart + USER_START.length, uEnd),
    after: body.slice(uEnd + USER_END.length),
  };
}

/** Extract just the managed region's inner text, for hashing / conflict checks. */
export function readManagedRegion(body: string): string | null {
  return splitRegions(body)?.managed ?? null;
}

/** Extract just the user region's inner text. */
export function readUserRegion(body: string): string | null {
  return splitRegions(body)?.user ?? null;
}

/**
 * Replace the managed region, leaving every other byte of the note untouched.
 * Throws {@link MissingMarkersError} when the markers are gone — callers must
 * decide (per conflict policy) rather than have the note rewritten wholesale.
 */
export function replaceManagedRegion(body: string, managedContent: string): string {
  const split = splitRegions(body);
  if (!split) throw new MissingMarkersError();
  return (
    split.before +
    MANAGED_START +
    managedContent +
    MANAGED_END +
    split.between +
    USER_START +
    split.user +
    USER_END +
    split.after
  );
}

/** Assemble a brand-new note body from managed and user content. */
export function composeBody(managedContent: string, userContent: string): string {
  return (
    `${MANAGED_START}${managedContent}${MANAGED_END}\n\n` +
    `${USER_START}${userContent}${USER_END}\n`
  );
}
