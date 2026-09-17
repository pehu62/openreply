import { NextRequest, NextResponse } from "next/server";
import { getDMQueue } from "@/lib/queue/client";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

/**
 * The comment queue, seen and emptied from outside the worker.
 *
 * The webhook route runs on Vercel and keeps queueing comments whether or not
 * the worker is up. Leave the worker off for a day and thousands of jobs pile
 * up, which is survivable — the hourly limiter drains them and the reconciler
 * brings back whatever was skipped — but there is no way to look at the size
 * of that backlog from the app, and no way to decide it is not worth sending.
 * This route provides both.
 *
 * GET    /api/admin/queue  -> job counts
 * DELETE /api/admin/queue  -> drop every waiting and delayed job
 *
 * Dropping jobs loses less than it sounds: the polling reconciler re-discovers
 * unhandled comments inside its lookback window, a few dozen per sweep, which
 * is the gradual version of the same catch-up.
 */

export const runtime = "nodejs";

export async function GET() {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const counts = await getDMQueue().getJobCounts(
    "waiting",
    "active",
    "delayed",
    "failed",
    "completed"
  );
  return NextResponse.json({ success: true, counts });
}

export async function DELETE(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }
  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only owners and admins can drain the queue" },
      { status: 403 }
    );
  }

  const queue = getDMQueue();
  const before = await queue.getJobCounts("waiting", "delayed");

  // Delayed jobs go too: most of them are rate-limit requeues of the same
  // backlog, and leaving them behind would drip it out over the following
  // hour instead of cancelling it.
  const includeDelayed =
    request.nextUrl.searchParams.get("delayed") !== "false";
  await queue.drain(includeDelayed);

  const after = await queue.getJobCounts("waiting", "delayed");
  return NextResponse.json({ success: true, before, after, includeDelayed });
}
