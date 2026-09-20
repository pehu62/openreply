import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { DmStatus } from "@/app/generated/prisma/client";

export async function GET(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const searchParams = request.nextUrl.searchParams;
  const page = Math.max(1, Number.parseInt(searchParams.get("page") ?? "1", 10));
  // The table view asks for twenty at a time. The ceiling is higher than it
  // needs to be for that, because exporting everyone who commented on one reel
  // is a few thousand rows and paging it fifty at a time is dozens of round
  // trips for a job that is read-only and momentary.
  const limit = Math.min(
    200,
    Math.max(1, Number.parseInt(searchParams.get("limit") ?? "20", 10))
  );
  const status = searchParams.get("status");
  const instagramAccountId = searchParams.get("instagramAccountId");
  // One reel at a time: "who commented on this post" is the question behind
  // every manual follow-up, and without it the only way to answer it is to
  // page the whole table and filter client side.
  const mediaId = searchParams.get("mediaId");
  const skip = (page - 1) * limit;
  const parsedStatus =
    status && Object.values(DmStatus).includes(status as DmStatus)
      ? (status as DmStatus)
      : null;

  const where = {
    workspaceId,
    ...(parsedStatus ? { status: parsedStatus } : {}),
    ...(instagramAccountId && instagramAccountId !== "all"
      ? { instagramAccountId }
      : {}),
    ...(mediaId ? { mediaId } : {}),
  };

  const [logs, total] = await Promise.all([
    prisma.dmLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
      include: {
        automation: { select: { name: true, keywords: true } },
        instagramAccount: { select: { username: true } },
      },
    }),
    prisma.dmLog.count({ where }),
  ]);

  return NextResponse.json({
    success: true,
    data: {
      logs,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    },
  });
}
