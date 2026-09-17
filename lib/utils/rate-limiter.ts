/**
 * Rate Limiter
 *
 * Redis-based rate limiter for Instagram private replies.
 *
 * Meta documents 750 private replies per hour per Instagram professional
 * account for comments on posts and reels. Exceeding it risks 429s and
 * app-level restrictions, so the worker requeues rather than pushing through.
 * https://developers.facebook.com/docs/graph-api/overview/rate-limiting/
 *
 * The budget here is far below that ceiling, and it is counted over a short
 * window rather than a long one. Both choices come from the same lesson: what
 * gets an account restricted is not only how many DMs go out in an hour but how
 * they are grouped. An hourly bucket of 150 is spent in the first three minutes
 * and then silent for fifty-seven, which is a machine's shape. The same 150 an
 * hour, metered a few at a time, is a person working through their comments.
 */

import Redis from "ioredis";

// Five sends per two minutes is 150 an hour, the same budget as before, spread
// instead of spent at once. Three restrictions in three weeks all followed days
// near Meta's documented ceiling, so the budget stays well under it; the short
// window is what keeps a backlog or a reel taking off from turning that budget
// into a single burst.
const RATE_LIMIT_MAX = 5; // private replies per window
const RATE_LIMIT_WINDOW = 120; // 2 minutes in seconds
// A blocked job waits far longer than one window before trying again. With a
// backlog of thousands, waking every job every window would put a few hundred
// database round-trips a minute behind a quota that only admits five, and the
// quota fills either way: the jobs that wake in any ten-minute stretch are
// already many times what it can take.
const REQUEUE_DELAY_MS = 10 * 60 * 1000; // 10 minutes
// Long enough to carry a job through roughly three hours of congestion. Past
// that it is dropped and the polling reconciler re-discovers it, which is the
// slower path back into the queue but costs nothing while it waits.
const MAX_REQUEUE_ATTEMPTS = 18;

let redis: Redis | null = null;

function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL!, {
      maxRetriesPerRequest: null, // required by BullMQ
    });
  }
  return redis;
}

export interface RateLimitResult {
  allowed: boolean;
  currentCount: number;
  remainingDMs: number;
  shouldRequeue: boolean;
  requeueDelayMs: number;
  shouldSkip: boolean;
  reserved: boolean;
}

const RESERVE_DM_SLOT_SCRIPT = `
local current = tonumber(redis.call("GET", KEYS[1]) or "0")
local max = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])

if current >= max then
  return {0, current, 0}
end

local next_count = redis.call("INCR", KEYS[1])
if next_count == 1 then
  redis.call("EXPIRE", KEYS[1], ttl)
end

return {1, next_count, max - next_count}
`;

function toScriptNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number.parseInt(value, 10);
  return 0;
}

function blockedResult(
  count: number,
  requeueAttempt: number
): RateLimitResult {
  if (requeueAttempt >= MAX_REQUEUE_ATTEMPTS) {
    return {
      allowed: false,
      currentCount: count,
      remainingDMs: 0,
      shouldRequeue: false,
      requeueDelayMs: 0,
      shouldSkip: true,
      reserved: false,
    };
  }

  return {
    allowed: false,
    currentCount: count,
    remainingDMs: 0,
    shouldRequeue: true,
    requeueDelayMs: REQUEUE_DELAY_MS,
    shouldSkip: false,
    reserved: false,
  };
}

/**
 * Check if an Instagram account is within its DM rate limit.
 *
 * Uses a Redis counter per account, expiring with the window.
 * Key pattern: `rate:dm:{instagramAccountId}`
 *
 * @param instagramAccountId - The Instagram account ID to check
 * @param requeueAttempt - How many times this job has been requeued (0 = first attempt)
 * @returns Rate limit result with action recommendations
 */
export async function checkRateLimit(
  instagramAccountId: string,
  requeueAttempt: number = 0
): Promise<RateLimitResult> {
  const client = getRedis();
  const key = `rate:dm:${instagramAccountId}`;

  const currentCount = await client.get(key);
  const count = currentCount ? parseInt(currentCount, 10) : 0;

  if (count >= RATE_LIMIT_MAX) {
    // Over the limit
    if (requeueAttempt >= MAX_REQUEUE_ATTEMPTS) {
      // Exceeded max requeue attempts — skip this DM
      return {
        allowed: false,
        currentCount: count,
        remainingDMs: 0,
        shouldRequeue: false,
        requeueDelayMs: 0,
        shouldSkip: true,
        reserved: false,
      };
    }

    return {
      allowed: false,
      currentCount: count,
      remainingDMs: 0,
      shouldRequeue: true,
      requeueDelayMs: REQUEUE_DELAY_MS,
      shouldSkip: false,
      reserved: false,
    };
  }

  return {
    allowed: true,
    currentCount: count,
    remainingDMs: RATE_LIMIT_MAX - count,
    shouldRequeue: false,
    requeueDelayMs: 0,
    shouldSkip: false,
    reserved: false,
  };
}

/**
 * Atomically reserve a DM send slot for an Instagram account.
 * This is the worker-safe path; it prevents concurrent jobs from all passing
 * the rate-limit check before any of them increments the Redis counter. With a
 * window of a couple of minutes and five slots in it, that race is no longer a
 * corner case: five concurrent jobs can exhaust a window between them.
 */
export async function reserveDMSlot(
  instagramAccountId: string,
  requeueAttempt: number = 0
): Promise<RateLimitResult> {
  const client = getRedis();
  const key = `rate:dm:${instagramAccountId}`;

  const result = await client.eval(
    RESERVE_DM_SLOT_SCRIPT,
    1,
    key,
    RATE_LIMIT_MAX,
    RATE_LIMIT_WINDOW
  );
  const values = Array.isArray(result) ? result : [];
  const allowedFlag = toScriptNumber(values[0]);
  const count = toScriptNumber(values[1]);
  const remaining = toScriptNumber(values[2]);

  if (allowedFlag !== 1) {
    return blockedResult(count, requeueAttempt);
  }

  return {
    allowed: true,
    currentCount: count,
    remainingDMs: remaining,
    shouldRequeue: false,
    requeueDelayMs: 0,
    shouldSkip: false,
    reserved: true,
  };
}

const RELEASE_DM_SLOT_SCRIPT = `
local current = tonumber(redis.call("GET", KEYS[1]) or "0")
if current <= 0 then
  return 0
end
return redis.call("DECR", KEYS[1])
`;

/**
 * Give back a slot reserved with reserveDMSlot when the send never happened.
 *
 * Meta's 750/hour cap counts private replies that were actually delivered, so
 * a send it rejected outright (comment deleted, thread gone, user
 * unreachable) should not eat into the budget — otherwise a run with a high
 * rejection rate, each rejected job retried a few times, exhausts the counter
 * in well under an hour while only a handful of DMs went out. Never called
 * for a Meta rate-limit error: that slot was genuinely spent.
 */
export async function releaseDMSlot(instagramAccountId: string): Promise<void> {
  const client = getRedis();
  const key = `rate:dm:${instagramAccountId}`;
  await client.eval(RELEASE_DM_SLOT_SCRIPT, 1, key);
}

/**
 * Backwards-compatible helper for tests and admin scripts.
 * Prefer reserveDMSlot in workers.
 */
export async function incrementDMCounter(
  instagramAccountId: string
): Promise<number> {
  const result = await reserveDMSlot(instagramAccountId, MAX_REQUEUE_ATTEMPTS);
  return result.currentCount;
}

/**
 * Get the current DM count for an Instagram account.
 */
export async function getCurrentDMCount(
  instagramAccountId: string
): Promise<number> {
  const client = getRedis();
  const key = `rate:dm:${instagramAccountId}`;
  const count = await client.get(key);
  return count ? parseInt(count, 10) : 0;
}

/**
 * Reset the rate limiter for an account (useful for testing).
 */
export async function resetRateLimit(
  instagramAccountId: string
): Promise<void> {
  const client = getRedis();
  const key = `rate:dm:${instagramAccountId}`;
  await client.del(key);
}

// Export constants for use in tests
export { RATE_LIMIT_MAX, RATE_LIMIT_WINDOW, REQUEUE_DELAY_MS, MAX_REQUEUE_ATTEMPTS };
