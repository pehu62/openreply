import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getDMQueue } from "@/lib/queue/client";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

/**
 * Re-queue comments whose DM never went out.
 *
 * When Meta refuses private replies for a while (an account or app
 * restriction), the worker still posts the public "check your DMs" reply, then
 * the DM fails and the comment is marked handled: the polling sweep never
 * comes back to it. Once Meta accepts sends again, this route re-enqueues those
 * comments so the people who were told to check their DMs finally get one.
 *
 * Only comments still inside Meta's private-reply window (7 days) are
 * eligible, one per person per post, and jobs are spread out over time so the
 * catch-up does not land as a burst right after a restriction was lifted.
 *
 * GET  /api/admin/retry-failed?days=7            -> preview: how many, oldest/newest
 * POST /api/admin/retry-failed?days=7&perHour=200&limit=500
 *                                                -> enqueue, spread at perHour
 */

export const runtime = "nodejs";

const WINDOW_DAYS_MAX = 7;

function readParams(request: NextRequest) {
  const q = request.nextUrl.searchParams;
  const days = Math.min(
    WINDOW_DAYS_MAX,
    Math.max(1, Number.parseInt(q.get("days") ?? "7", 10) || 7)
  );
  const perHour = Math.min(
    600,
    Math.max(10, Number.parseInt(q.get("perHour") ?? "200", 10) || 200)
  );
  const limit = Math.min(
    5000,
    Math.max(1, Number.parseInt(q.get("limit") ?? "500", 10) || 500)
  );
  return { days, perHour, limit };
}

async function eligible(workspaceId: string, days: number, limit: number) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await prisma.dmLog.findMany({
    where: {
      workspaceId,
      status: "FAILED",
      dmSentAt: null,
      publicReplySentAt: { not: null },
      createdAt: { gte: since },
      automation: { isActive: true },
      // Only failures that a restriction or a throttle explains. A comment
      // Meta calls "invalid for a private reply" or a user it "cannot find"
      // will fail again exactly the same way, and is left alone.
      OR: [
        { errorMessage: { contains: "thread owner has archived" } },
        { errorMessage: { contains: "rate limit" } },
      ],
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      commentId: true,
      commentText: true,
      commenterId: true,
      commenterName: true,
      mediaId: true,
      createdAt: true,
      errorMessage: true,
      automationId: true,
      instagramAccount: { select: { instagramId: true } },
    },
  });

  // One delivery per person per post, whatever the number of failed comments.
  const seen = new Set<string>();
  const picked: typeof rows = [];
  for (const row of rows) {
    const key = `${row.commenterId}:${row.mediaId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(row);
    if (picked.length >= limit) break;
  }
  return { total: rows.length, picked };
}

export async function GET(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }
  const { days, limit } = readParams(request);
  const { total, picked } = await eligible(context.workspaceId, days, limit);
  const reasons: Record<string, number> = {};
  for (const row of picked) {
    const key = (row.errorMessage ?? "unknown").slice(0, 60);
    reasons[key] = (reasons[key] ?? 0) + 1;
  }
  return NextResponse.json({
    success: true,
    days,
    failedInWindow: total,
    eligible: picked.length,
    oldest: picked[0]?.createdAt ?? null,
    newest: picked[picked.length - 1]?.createdAt ?? null,
    reasons,
  });
}

export async function POST(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }
  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only owners and admins can retry sends" },
      { status: 403 }
    );
  }

  const { days, perHour, limit } = readParams(request);
  const { picked } = await eligible(context.workspaceId, days, limit);
  const queue = getDMQueue();
  const gapMs = Math.floor((60 * 60 * 1000) / perHour);
  const batch = Date.now();

  let enqueued = 0;
  for (const [index, row] of picked.entries()) {
    if (!row.mediaId) continue;
    await queue.add(
      "process-comment",
      {
        instagramAccountId: row.instagramAccount.instagramId,
        commentId: row.commentId,
        commentText: row.commentText,
        commenterId: row.commenterId,
        commenterName: row.commenterName ?? undefined,
        mediaId: row.mediaId,
        source: "POLLING",
      },
      {
        delay: index * gapMs,
        // A fresh id per batch: the original comment_<acct>_<id> job may still
        // be retained as failed, which would silently swallow a re-add.
        jobId: `retry_${batch}_${row.commentId}`,
      }
    );
    enqueued += 1;
  }

  return NextResponse.json({
    success: true,
    enqueued,
    perHour,
    spreadMinutes: Math.ceil((enqueued * gapMs) / 60000),
  });
}
