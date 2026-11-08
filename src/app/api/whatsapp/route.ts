import { after } from "next/server";
import { drainConversation, receiveInbound } from "@/lib/agent/handle-inbound";
import { inboundDeps, webhookConfig } from "@/lib/agent/runtime";
import { EMPTY_TWIML, isValidTwilioSignature, WhatsAppInboundSchema } from "@/lib/channels/whatsapp";

export const maxDuration = 60;

export async function POST(request: Request) {
  const { authToken, webhookUrl } = webhookConfig();
  const params = Object.fromEntries(new URLSearchParams(await request.text()));

  if (!isValidTwilioSignature(request.headers.get("x-twilio-signature"), webhookUrl, params, authToken)) {
    return new Response("Forbidden", { status: 403 });
  }

  const inbound = WhatsAppInboundSchema.safeParse(params);
  if (!inbound.success) return new Response("Bad request", { status: 400 });

  const deps = inboundDeps();
  const received = await receiveInbound(deps, {
    providerMessageId: inbound.data.MessageSid,
    from: inbound.data.From,
    to: inbound.data.To,
    body: inbound.data.Body,
  });

  // Twilio allows 15 seconds in total, so the reply goes out after this response.
  if (received.status === "queued") {
    after(() =>
      drainConversation(deps, received.tenant, received.conversationId).catch((error: unknown) => {
        deps.log("inbound.drain_failed", { conversationId: received.conversationId, error: String(error).slice(0, 200) });
      }),
    );
  }

  return new Response(EMPTY_TWIML, { headers: { "Content-Type": "text/xml" } });
}
