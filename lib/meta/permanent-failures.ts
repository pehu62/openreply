/**
 * Send failures that will never succeed, however many times they are tried.
 *
 * A private reply can be refused for reasons that are settled facts about the
 * comment or the person: the comment was deleted, the account is gone, the
 * conversation was archived, the comment already had its one allowed private
 * reply. Retrying any of those produces the identical refusal.
 *
 * That matters more than it sounds, because Meta throttles on calls attempted,
 * not on messages delivered. A few hundred dead comments, each retried by the
 * queue and re-discovered by the polling sweep every five minutes, generate
 * thousands of refused calls an hour, and the account is then rate limited out
 * of the sends that would have worked. Recognising a dead end and recording it
 * is what keeps the budget for the people who can actually be reached.
 */
export const PERMANENT_SEND_FAILURES = [
  "invalid for a private reply",
  "requested user cannot be found",
  "thread owner has archived",
] as const;

/** Whether this failure is a settled fact rather than a passing condition. */
export function isPermanentSendFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return PERMANENT_SEND_FAILURES.some((fragment) => message.includes(fragment));
}
