import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { z } from "zod";
import { handleInline } from "@/lib/agent/handle-inbound";
import { RATE_LIMITED_TEXT, staticReply } from "@/lib/agent/reply";
import { demoConfig, inboundDeps, WEB_DEADLINE_MS, webIpLimiter } from "@/lib/agent/runtime";
import { ChatRequestSchema, VISITOR_COOKIE, webInbound } from "@/lib/channels/web";

export const maxDuration = 30;

const DAY_SECONDS = 86_400;

/** The first hop Vercel or the tunnel reports. Unknown locally, which shares one bucket. */
function clientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
}

export async function POST(request: Request) {
  const demo = demoConfig();
  if (!demo) return new Response("Not found", { status: 404 });

  // Before anything touches the database: the demo is public and has no login.
  if (!(await webIpLimiter().check(clientIp(request))).ok) {
    return Response.json({ replies: [staticReply(RATE_LIMITED_TEXT, "rate_limited")] });
  }

  const body = ChatRequestSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return new Response("Bad request", { status: 400 });

  const jar = await cookies();
  const existing = z.uuid().safeParse(jar.get(VISITOR_COOKIE)?.value);
  const visitorId = existing.success ? existing.data : randomUUID();
  jar.set(VISITOR_COOKIE, visitorId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: DAY_SECONDS,
    path: "/",
  });

  const replies = await handleInline(inboundDeps(WEB_DEADLINE_MS, { demoCap: true }), webInbound(visitorId, body.data, demo.receivingNumber));
  return Response.json({ replies });
}

/** Restart: the next message starts a new visitor, consent included. */
export async function DELETE() {
  if (!demoConfig()) return new Response("Not found", { status: 404 });
  (await cookies()).delete(VISITOR_COOKIE);
  return new Response(null, { status: 204 });
}
