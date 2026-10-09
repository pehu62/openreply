/**
 * How far back a reconciliation sweep looks, on both of its axes.
 *
 * The sweep is bounded by time and by posts, and the two only work as a pair.
 * Widening the lookback window alone changes nothing on an account that
 * publishes several reels a day: a reel drops out of the scanned set within a
 * couple of days, and every unserved comment on it becomes invisible to the
 * sweep however old the window allows. That is how a backlog survives a
 * catch-up that looks correct from the outside, so both numbers live here
 * together, next to the reason.
 *
 * Kept free of database and Meta imports so the bounds can be reasoned about,
 * and tested, without standing up either.
 */

/** Hours of comment history a sweep considers. */
export const DEFAULT_LOOKBACK_HOURS = 72;
/** Recent posts a sweep scans for an "any post" campaign. */
export const DEFAULT_RECENT_MEDIA_LIMIT = 10;
/**
 * The feed is fetched one page deep at twice the post limit, and Instagram
 * caps a page at 100. A larger value would quietly scan fewer posts than it
 * claims, which is worse than refusing to grow.
 */
export const MAX_RECENT_MEDIA_LIMIT = 50;

function positiveNumber(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function resolveLookbackHours(raw: string | undefined): number {
  return positiveNumber(raw, DEFAULT_LOOKBACK_HOURS);
}

export function resolveRecentMediaLimit(raw: string | undefined): number {
  const wanted = positiveNumber(raw, DEFAULT_RECENT_MEDIA_LIMIT);
  return Math.min(MAX_RECENT_MEDIA_LIMIT, Math.floor(wanted));
}
