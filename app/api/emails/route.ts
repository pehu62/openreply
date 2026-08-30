import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";

/**
 * Email addresses people send back in a DM, after the campaign follow-up asks
 * for one.
 *
 * Nothing is written at webhook time on purpose: every inbound DM already
 * lands whole in WebhookEvent.payload, so this route reads that history and
 * extracts the addresses on demand. Keeping the capture read-only means the
 * send path that actually delivers DMs stays untouched.
 *
 * GET /api/emails              -> JSON, newest window first
 * GET /api/emails?format=csv   -> CSV download, ready for a Substack import
 * GET /api/emails?days=30      -> narrow the window (default 90, max 365)
 */

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

type Capture = {
  email: string;
  senderId: string;
  capturedAt: string;
};

function collectFromPayload(
  payload: unknown,
  seenAt: Date,
  out: Map<string, Capture>
): void {
  if (!payload || typeof payload !== "object") return;

  const entries = (payload as { entry?: unknown }).entry;
  if (!Array.isArray(entries)) return;

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;

    const accountId = (entry as { id?: unknown }).id;
    const messaging = (entry as { messaging?: unknown }).messaging;
    if (!Array.isArray(messaging)) continue;

    for (const item of messaging) {
      if (!item || typeof item !== "object") continue;

      const message = (item as { message?: unknown }).message;
      if (!message || typeof message !== "object") continue;

      // Echoes are the account's own outgoing DMs coming back as events.
      if ((message as { is_echo?: unknown }).is_echo === true) continue;

      const sender = (item as { sender?: unknown }).sender;
      const senderId =
        sender && typeof sender === "object"
          ? (sender as { id?: unknown }).id
          : undefined;
      if (typeof senderId !== "string") continue;
      if (typeof accountId === "string" && senderId === accountId) continue;

      const text = (message as { text?: unknown }).text;
      if (typeof text !== "string" || text.length === 0) continue;

      const matches = text.match(EMAIL_PATTERN);
      if (!matches) continue;

      for (const raw of matches) {
        const email = raw.toLowerCase();
        const existing = out.get(email);
        // Keep the first time an address was seen.
        if (existing && new Date(existing.capturedAt) <= seenAt) continue;
        out.set(email, {
          email,
          senderId,
          capturedAt: seenAt.toISOString(),
        });
      }
    }
  }
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export async function GET(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const searchParams = request.nextUrl.searchParams;
  const days = Math.min(
    365,
    Math.max(1, Number.parseInt(searchParams.get("days") ?? "90", 10) || 90)
  );
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const events = await prisma.webhookEvent.findMany({
    where: { workspaceId, createdAt: { gte: since } },
    orderBy: { createdAt: "asc" },
    select: { payload: true, createdAt: true },
  });

  const found = new Map<string, Capture>();
  for (const event of events) {
    collectFromPayload(event.payload, event.createdAt, found);
  }

  const captures = [...found.values()].sort((a, b) =>
    a.capturedAt.localeCompare(b.capturedAt)
  );

  // Put an Instagram handle next to the address when the same person also
  // shows up in the DM logs.
  const senderIds = [...new Set(captures.map((capture) => capture.senderId))];
  const logged = senderIds.length
    ? await prisma.dmLog.findMany({
        where: { workspaceId, commenterId: { in: senderIds } },
        select: { commenterId: true, commenterName: true },
        distinct: ["commenterId"],
      })
    : [];
  const handles = new Map<string, string>();
  for (const row of logged) {
    if (typeof row.commenterName === "string" && row.commenterName.length > 0) {
      handles.set(String(row.commenterId), row.commenterName);
    }
  }

  const rows = captures.map((capture) => ({
    email: capture.email,
    username: handles.get(capture.senderId) ?? null,
    capturedAt: capture.capturedAt,
  }));

  if (searchParams.get("format") === "csv") {
    const lines = ["email,name,source,collected_at"];
    for (const row of rows) {
      lines.push(
        [
          csvCell(row.email),
          csvCell(row.username ?? ""),
          "openreply",
          csvCell(row.capturedAt),
        ].join(",")
      );
    }
    const today = new Date().toISOString().slice(0, 10);
    return new NextResponse(`${lines.join("\n")}\n`, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="newsletter-emails-${today}.csv"`,
      },
    });
  }

  return NextResponse.json({
    success: true,
    count: rows.length,
    windowDays: days,
    emails: rows,
  });
}
