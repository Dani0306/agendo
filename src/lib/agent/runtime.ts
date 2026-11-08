import "server-only";
import { z } from "zod";
import { sendWhatsApp } from "@/lib/channels/whatsapp";
import { db } from "@/lib/db/client";
import { conversationStore } from "@/lib/db/conversations";
import { loadPiiSecrets } from "@/lib/pii/phone";
import type { InboundDeps } from "./handle-inbound";

const WhatsAppEnvSchema = z.object({
  TWILIO_ACCOUNT_SID: z.string().startsWith("AC"),
  TWILIO_AUTH_TOKEN: z.string().min(1),
  TWILIO_WHATSAPP_FROM: z.string().startsWith("whatsapp:+"),
  TWILIO_WEBHOOK_URL: z.url(),
  PRIVACY_POLICY_URL: z.url(),
});

export function webhookConfig() {
  const env = WhatsAppEnvSchema.parse(process.env);
  return { authToken: env.TWILIO_AUTH_TOKEN, webhookUrl: env.TWILIO_WEBHOOK_URL };
}

/** Wires the real database, Twilio and secrets into the core. */
export function inboundDeps(): InboundDeps {
  const env = WhatsAppEnvSchema.parse(process.env);
  const credentials = {
    accountSid: env.TWILIO_ACCOUNT_SID,
    authToken: env.TWILIO_AUTH_TOKEN,
    from: env.TWILIO_WHATSAPP_FROM,
  };
  return {
    store: conversationStore(db()),
    send: (phone, body) => sendWhatsApp({ to: phone, body }, credentials),
    secrets: loadPiiSecrets(),
    privacyUrl: env.PRIVACY_POLICY_URL,
    now: () => new Date(),
    log: (event, fields) => console.info(JSON.stringify({ event, ...fields })),
  };
}
