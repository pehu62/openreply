/**
 * Rate Limiter — Unit Tests
 *
 * Tests private-reply cap enforcement using mocked Redis.
 * Assertions derive from the exported constants so they survive a change to the
 * cap, the window or the number of retries a blocked job is given. That matters
 * more than it sounds: the cap has moved three times, and each move was made
 * under pressure, when a test failing for an arithmetic reason would have been
 * one more thing to read past.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGet, mockEval, mockDel } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockEval: vi.fn(),
  mockDel: vi.fn(),
}));

vi.mock("ioredis", () => {
  const MockRedis = vi.fn().mockImplementation(function (
    this: Record<string, unknown>
  ) {
    this.get = mockGet;
    this.eval = mockEval;
    this.del = mockDel;
    return this;
  });
  return { default: MockRedis };
});

vi.stubEnv("REDIS_URL", "redis://localhost:6379");

import {
  checkRateLimit,
  incrementDMCounter,
  reserveDMSlot,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW,
  MAX_REQUEUE_ATTEMPTS,
} from "../lib/utils/rate-limiter";

// One below the cap, whatever the cap currently is.
const UNDER_CAP = RATE_LIMIT_MAX - 1;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("checkRateLimit", () => {
  it("should allow when count is below limit", async () => {
    mockGet.mockResolvedValue(String(UNDER_CAP));

    const result = await checkRateLimit("account_123");

    expect(result.allowed).toBe(true);
    expect(result.currentCount).toBe(UNDER_CAP);
    expect(result.remainingDMs).toBe(RATE_LIMIT_MAX - UNDER_CAP);
    expect(result.shouldRequeue).toBe(false);
    expect(result.shouldSkip).toBe(false);
    expect(result.reserved).toBe(false);
  });

  it("should allow when no previous count exists", async () => {
    mockGet.mockResolvedValue(null);

    const result = await checkRateLimit("account_123");

    expect(result.allowed).toBe(true);
    expect(result.currentCount).toBe(0);
    expect(result.remainingDMs).toBe(RATE_LIMIT_MAX);
  });

  it("should deny when count reaches the limit", async () => {
    mockGet.mockResolvedValue(String(RATE_LIMIT_MAX));

    const result = await checkRateLimit("account_123");

    expect(result.allowed).toBe(false);
    expect(result.shouldRequeue).toBe(true);
    expect(result.shouldSkip).toBe(false);
  });

  it("should skip after max requeue attempts", async () => {
    mockGet.mockResolvedValue(String(RATE_LIMIT_MAX));

    const result = await checkRateLimit("account_123", MAX_REQUEUE_ATTEMPTS);

    expect(result.allowed).toBe(false);
    expect(result.shouldRequeue).toBe(false);
    expect(result.shouldSkip).toBe(true);
  });

  it("waits much longer than one window before trying again", async () => {
    // A backlog of thousands all retrying once per window would cost a few
    // hundred database round-trips a minute to hand out five slots, so the wait
    // is deliberately several windows long. The quota still fills: far more
    // jobs wake in that stretch than it can admit.
    mockGet.mockResolvedValue(String(RATE_LIMIT_MAX));

    const result = await checkRateLimit("account_123");

    expect(result.requeueDelayMs).toBeGreaterThan(RATE_LIMIT_WINDOW * 1000 * 2);
  });
});

describe("reserveDMSlot", () => {
  it("should atomically reserve a slot when below the cap", async () => {
    mockEval.mockResolvedValue([1, UNDER_CAP, RATE_LIMIT_MAX - UNDER_CAP]);

    const result = await reserveDMSlot("account_123");

    expect(mockEval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      "rate:dm:account_123",
      RATE_LIMIT_MAX,
      RATE_LIMIT_WINDOW
    );
    expect(result.allowed).toBe(true);
    expect(result.reserved).toBe(true);
    expect(result.currentCount).toBe(UNDER_CAP);
    expect(result.remainingDMs).toBe(RATE_LIMIT_MAX - UNDER_CAP);
  });

  it("should recommend requeue when the atomic reserve is denied", async () => {
    mockEval.mockResolvedValue([0, RATE_LIMIT_MAX, 0]);

    const result = await reserveDMSlot("account_123", 0);

    expect(result.allowed).toBe(false);
    expect(result.reserved).toBe(false);
    expect(result.shouldRequeue).toBe(true);
    expect(result.shouldSkip).toBe(false);
  });

  it("should skip after max requeue attempts", async () => {
    mockEval.mockResolvedValue(["0", String(RATE_LIMIT_MAX), "0"]);

    const result = await reserveDMSlot("account_123", MAX_REQUEUE_ATTEMPTS);

    expect(result.allowed).toBe(false);
    expect(result.shouldRequeue).toBe(false);
    expect(result.shouldSkip).toBe(true);
  });
});

describe("incrementDMCounter", () => {
  it("should use the atomic reservation path", async () => {
    mockEval.mockResolvedValue([1, UNDER_CAP, RATE_LIMIT_MAX - UNDER_CAP]);

    const count = await incrementDMCounter("account_123");

    expect(mockEval).toHaveBeenCalled();
    expect(count).toBe(UNDER_CAP);
  });
});
