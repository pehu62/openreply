import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getRedisConnection } from "@/lib/queue/client";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

/**
 * The worker's hourly private-reply counter, per connected Instagram account.
 *
 * The counter lives in Redis under `rate:dm:<instagramId>` and is meant to
 * expire an hour after its first increment. If that expiry is ever lost the
 * counter climbs forever, every DM is requeued as "Hourly rate limit hit"
 * although the account is nowhere near the cap, and after three requeues the
 * DM is dropped for good — with the public reply already posted. This route
 * makes the counter visible and lets an owner reset it.
 *
 * GET    /api/admin/rate-limit  -> count, ttl (seconds; -1 = no expiry) per account
 * DELETE /api/admin/rate-limit  -> clears the counters for this workspace's accounts
 */

export const runtime = "nodejs";

async function workspaceAccounts(workspaceId: string) {
  return prisma.instagramAccount.findMany({
    where: { workspaceId },
    select: { instagramId: true, username: true },
  });
}

export async function GET() {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const redis = getRedisConnection();
  const accounts = await workspaceAccounts(context.workspaceId);
  const data = await Promise.all(
    accounts.map(async (account: { instagramId: string; username: string }) => {
      const key = `rate:dm:${account.instagramId}`;
      const [count, ttl] = await Promise.all([redis.get(key), redis.ttl(key)]);
      return {
        username: account.username,
        instagramId: account.instagramId,
        count: count ? Number.parseInt(count, 10) : 0,
        ttlSeconds: ttl,
      };
    })
  );

  return NextResponse.json({ success: true, data });
}

export async function DELETE() {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }
  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only owners and admins can reset the counter" },
      { status: 403 }
    );
  }

  const redis = getRedisConnection();
  const accounts = await workspaceAccounts(context.workspaceId);
  const cleared: string[] = [];
  for (const account of accounts) {
    const key = `rate:dm:${account.instagramId}`;
    if ((await redis.del(key)) > 0) cleared.push(account.username);
  }

  return NextResponse.json({ success: true, cleared });
}
