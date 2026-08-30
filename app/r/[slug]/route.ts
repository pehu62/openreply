import { NextRequest, NextResponse, after } from "next/server";
import { prisma } from "@/lib/db/client";
import { getRequestIp, hashClickIp } from "@/lib/tracking/server";

type RedirectRouteProps = {
  params: Promise<{ slug: string }>;
};

export async function GET(request: NextRequest, { params }: RedirectRouteProps) {
  const { slug } = await params;
  const trackedLink = await prisma.trackedLink.findUnique({
    where: { slug },
    select: {
      id: true,
      workspaceId: true,
      automationId: true,
      destinationUrl: true,
      automation: {
        select: {
          instagramAccountId: true,
        },
      },
    },
  });

  if (!trackedLink) {
    return NextResponse.redirect(new URL("/", request.url), { status: 302 });
  }

  // These links are opened inside Instagram's in-app browser, which gives up on
  // a slow response and shows its own error page instead of following the
  // redirect — the person taps through and lands nowhere. So the click is
  // recorded with `after`, once the redirect has already been sent, and a
  // failure to record it can never cost a visit. Request-derived values are
  // read here because the request is gone by the time the callback runs.
  const ipHash = hashClickIp(getRequestIp(request));
  const userAgent = request.headers.get("user-agent");
  const referrer = request.headers.get("referer");

  after(async () => {
    try {
      await prisma.linkClick.create({
        data: {
          workspaceId: trackedLink.workspaceId,
          automationId: trackedLink.automationId,
          instagramAccountId: trackedLink.automation.instagramAccountId,
          trackedLinkId: trackedLink.id,
          ipHash,
          userAgent,
          referrer,
        },
      });
    } catch (error) {
      console.error(`[tracked-link] failed to record click for ${slug}`, error);
    }
  });

  return NextResponse.redirect(trackedLink.destinationUrl, { status: 302 });
}
