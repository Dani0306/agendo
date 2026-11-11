import { handleInline } from "@/lib/agent/handle-inbound";
import { inboundDeps, webhookConfig, WHATSAPP_DEADLINE_MS } from "@/lib/agent/runtime";
import { isValidTwilioSignature, twimlReply, WhatsAppInboundSchema } from "@/lib/channels/whatsapp";

export const maxDuration = 15;

export async function POST(request: Request) {
  const { authToken, webhookUrl } = webhookConfig();
  const params = Object.fromEntries(new URLSearchParams(await request.text()));

  if (!isValidTwilioSignature(request.headers.get("x-twilio-signature"), webhookUrl, params, authToken)) {
    return new Response("Forbidden", { status: 403 });
  }

  const inbound = WhatsAppInboundSchema.safeParse(params);
  if (!inbound.success) return new Response("Bad request", { status: 400 });

  // The Twilio trial refuses free-text REST sends (error 21654), so replies ride in this
  // response. Phase 1's exit check is still open on whether Twilio delivers them.
  const replies = await handleInline(inboundDeps(WHATSAPP_DEADLINE_MS), {
    channel: "whatsapp",
    providerMessageId: inbound.data.MessageSid,
    from: inbound.data.From,
    to: inbound.data.To,
    body: inbound.data.Body,
  });

  return new Response(twimlReply(replies.map((reply) => reply.text)), { headers: { "Content-Type": "text/xml" } });
}
