import { describe, expect, it } from "vitest";

import {
  DEFAULT_LOOKBACK_HOURS,
  DEFAULT_RECENT_MEDIA_LIMIT,
  MAX_RECENT_MEDIA_LIMIT,
  resolveLookbackHours,
  resolveRecentMediaLimit,
} from "../lib/polling/sweep-bounds";

/**
 * The sweep is bounded on two axes, time and posts, and an operator who only
 * knows about the first will conclude the safety net is broken. A comment left
 * unserved during an incident is reachable again only if BOTH bounds reach
 * back far enough, and on an account posting several reels a day the post
 * count binds first.
 */

describe("resolveLookbackHours", () => {
  it("defaults when unset", () => {
    expect(resolveLookbackHours(undefined)).toBe(DEFAULT_LOOKBACK_HOURS);
  });

  it("takes the configured window", () => {
    expect(resolveLookbackHours("168")).toBe(168);
  });

  it("ignores values that would scan nothing", () => {
    for (const raw of ["", "abc", "0", "-5"]) {
      expect(resolveLookbackHours(raw)).toBe(DEFAULT_LOOKBACK_HOURS);
    }
  });
});

describe("resolveRecentMediaLimit", () => {
  it("defaults to ten posts", () => {
    expect(resolveRecentMediaLimit(undefined)).toBe(DEFAULT_RECENT_MEDIA_LIMIT);
  });

  it("widens when asked, so a catch-up can reach posts from several days back", () => {
    expect(resolveRecentMediaLimit("40")).toBe(40);
  });

  it("refuses to grow past one page of feed rather than scan fewer posts than it claims", () => {
    expect(resolveRecentMediaLimit("500")).toBe(MAX_RECENT_MEDIA_LIMIT);
    // The feed is fetched at twice the limit, and a page caps at 100.
    expect(MAX_RECENT_MEDIA_LIMIT * 2).toBeLessThanOrEqual(100);
  });

  it("never returns a fraction, since it indexes a list", () => {
    expect(Number.isInteger(resolveRecentMediaLimit("12.7"))).toBe(true);
    expect(resolveRecentMediaLimit("12.7")).toBe(12);
  });

  it("ignores values that would scan nothing", () => {
    for (const raw of ["", "abc", "0", "-5"]) {
      expect(resolveRecentMediaLimit(raw)).toBe(DEFAULT_RECENT_MEDIA_LIMIT);
    }
  });
});
