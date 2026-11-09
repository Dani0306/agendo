import { drainConversation, receiveInbound } from "@/lib/agent/handle-inbound";
import { inboundDeps, webhookConfig } from "@/lib/agent/runtime";
import { EMPTY_TWIML, isValidTwilioSignature, twimlReply, WhatsAppInboundSchema } from "@/lib/channels/whatsapp";

export const maxDuration = 15;

const XML = { "Content-Type": "text/xml" };

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
  if (received.status !== "queued") return new Response(EMPTY_TWIML, { headers: XML });

  // The Twilio trial refuses free-text REST sends (error 21654), so replies ride in this
  // response instead. That only fits work that finishes inside Twilio's 15 seconds, which
  // holds for the static consent replies. T13 must revisit this before the agent loop lands.
  const replies: string[] = [];
  const inlineDeps = {
    ...deps,
    send: async (_phone: string, text: string) => {
      replies.push(text);
      return `twiml:${inbound.data.MessageSid}:${replies.length}`;
    },
  };

  try {
    await drainConversation(inlineDeps, received.tenant, received.conversationId);
  } catch (error: unknown) {
    deps.log("inbound.drain_failed", { conversationId: received.conversationId, error: String(error).slice(0, 200) });
  }

  return new Response(replies.length > 0 ? twimlReply(replies) : EMPTY_TWIML, { headers: XML });
}
