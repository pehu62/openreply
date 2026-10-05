import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MetaApiError,
  RateLimitError,
  sendPrivateReply,
} from "../lib/meta/client";

/**
 * How a Meta error is classified decides whether the worker calls Meta again.
 * A throttle that is not recognised as one gets retried as text, then three
 * more times by the queue, then again by the next sweep, and every one of
 * those is a call Meta counts against the same throttle. So the mapping from
 * error code to error class is load bearing, not cosmetic.
 */

function respondWithError(code: number, subcode: number, message: string) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status: 400,
    url: "https://graph.instagram.com/v25.0/17841410574717485/messages?access_token=secret",
    json: async () => ({
      error: {
        message,
        type: "IGApiException",
        code,
        error_subcode: subcode,
        fbtrace_id: "Atrace",
      },
    }),
  });
}

const originalFetch = global.fetch;

beforeEach(() => {
  vi.stubEnv("META_GRAPH_API_VERSION", "v25.0");
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.unstubAllEnvs();
});

describe("Meta error classification", () => {
  it("treats 613 as a rate limit", async () => {
    global.fetch = respondWithError(
      613,
      2534040,
      "The rate limit has exceeded. Please retry again after some time"
    ) as unknown as typeof fetch;

    await expect(
      sendPrivateReply("token", "17841410574717485", "comment_1", "hello")
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("keeps the trace and the real code in the message", async () => {
    global.fetch = respondWithError(
      613,
      2534040,
      "The rate limit has exceeded. Please retry again after some time"
    ) as unknown as typeof fetch;

    await expect(
      sendPrivateReply("token", "17841410574717485", "comment_1", "hello")
    ).rejects.toThrow(/code=613 sub=2534040 .*trace=Atrace/);
  });

  it("does not drop the access token into the error message", async () => {
    global.fetch = respondWithError(613, 2534040, "The rate limit has exceeded") as unknown as typeof fetch;

    await expect(
      sendPrivateReply("token", "17841410574717485", "comment_1", "hello")
    ).rejects.toThrow(/\/v25\.0\/17841410574717485\/messages\)/);
    await expect(
      sendPrivateReply("token", "17841410574717485", "comment_1", "hello")
    ).rejects.not.toThrow(/secret/);
  });

  it("leaves an ordinary refusal as a plain MetaApiError", async () => {
    global.fetch = respondWithError(
      100,
      2534001,
      "The thread owner has archived or deleted this conversation"
    ) as unknown as typeof fetch;

    const error = await sendPrivateReply(
      "token",
      "17841410574717485",
      "comment_1",
      "hello"
    ).catch((e) => e);

    expect(error).toBeInstanceOf(MetaApiError);
    expect(error).not.toBeInstanceOf(RateLimitError);
  });
});
