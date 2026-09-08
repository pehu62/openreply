import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@/app/generated/prisma/client";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";

/**
 * Raw webhook payloads for one comment, for diagnosis.
 *
 * Every webhook Meta sends lands whole in WebhookEvent.payload before any
 * filtering happens, so this is the only place that shows what the comment
 * really looked like on arrival — whether it carried a parent_id (a thread
 * reply), which media_product_type it had, and so on. Read-only.
 *
 * GET /api/webhook-events?commentId=<id>   -> up to 20 matching events
 *
 * Events are matched by a text search of the stored payload and then narrowed
 * to entries addressed to one of this workspace's Instagram accounts, so a
 * workspace never sees another workspace's traffic. Events dropped before
 * routing (a filtered thread reply, for instance) never get a workspaceId
 * stamped on them, which is why the search cannot rely on that column alone.
 */

export const runtime = "nodejs";

type RawEvent = {
  id: string;
  status: string;
  errorMessage: string | null;
  createdAt: Date;
  processedAt: Date | null;
  payload: unknown;
};

function entriesFor(payload: unknown, accountIds: Set<string>): unknown[] {
  if (!payload || typeof payload !== "object") return [];
  const entries = (payload as { entry?: unknown }).entry;
  if (!Array.isArray(entries)) return [];
  return entries.filter((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const id = (entry as { id?: unknown }).id;
    return typeof id === "string" && accountIds.has(id);
  });
}

export async function GET(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const commentId = request.nextUrl.searchParams.get("commentId")?.trim();
  if (!commentId || !/^\d{5,40}$/.test(commentId)) {
    return NextResponse.json(
      { success: false, error: "commentId (numeric) is required" },
      { status: 400 }
    );
  }

  const accounts = await prisma.instagramAccount.findMany({
    where: { workspaceId },
    select: { instagramId: true },
  });
  const accountIds = new Set<string>(accounts.map((a: { instagramId: string }) => a.instagramId));

  const rows = await prisma.$queryRaw<RawEvent[]>(
    Prisma.sql`
      SELECT "id", "status", "errorMessage", "createdAt", "processedAt", "payload"
      FROM "WebhookEvent"
      WHERE ("workspaceId" = ${workspaceId} OR "workspaceId" IS NULL)
        AND "payload"::text LIKE ${"%" + commentId + "%"}
      ORDER BY "createdAt" DESC
      LIMIT 20
    `
  );

  const events = rows
    .map((row: RawEvent) => ({
      id: row.id,
      status: row.status,
      errorMessage: row.errorMessage,
      createdAt: row.createdAt,
      processedAt: row.processedAt,
      entries: entriesFor(row.payload, accountIds),
    }))
    .filter((row: { entries: unknown[] }) => row.entries.length > 0);

  return NextResponse.json({ success: true, commentId, events });
}
