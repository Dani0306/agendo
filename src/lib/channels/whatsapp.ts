import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/** Sent back to Twilio when the reply goes out separately through the REST API. */
export const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

export const WhatsAppInboundSchema = z.object({
  MessageSid: z.string().regex(/^(SM|MM)[0-9a-zA-Z]+$/),
  From: z.string().startsWith("whatsapp:+"),
  To: z.string().startsWith("whatsapp:+"),
  Body: z.string().default(""),
});

export type WhatsAppInbound = z.infer<typeof WhatsAppInboundSchema>;

/** The exact URL configured in Twilio, then each parameter name and value, sorted by name. */
export function computeTwilioSignature(url: string, params: Record<string, string>, authToken: string): string {
  const names = Object.keys(params).sort();
  const signed = names.reduce((text, name) => text + name + params[name], url);
  return createHmac("sha1", authToken).update(signed, "utf8").digest("base64");
}

export function isValidTwilioSignature(
  signature: string | null,
  url: string,
  params: Record<string, string>,
  authToken: string,
): boolean {
  if (!signature) return false;
  const expected = Buffer.from(computeTwilioSignature(url, params, authToken));
  const received = Buffer.from(signature);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export type TwilioCredentials = { accountSid: string; authToken: string; from: string };

/** Sends free-form text and returns the Twilio message SID. Errors carry no phone number. */
export async function sendWhatsApp(
  message: { to: string; body: string },
  credentials: TwilioCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const to = message.to.startsWith("whatsapp:") ? message.to : `whatsapp:${message.to}`;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${credentials.accountSid}/Messages.json`;
  const authorization = Buffer.from(`${credentials.accountSid}:${credentials.authToken}`).toString("base64");

  const response = await fetchImpl(url, {
    method: "POST",
    headers: { Authorization: `Basic ${authorization}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: to, From: credentials.from, Body: message.body }),
  });

  if (!response.ok) {
    const failure = z.object({ code: z.number().optional() }).safeParse(await response.json().catch(() => ({})));
    throw new Error(`Twilio send failed: HTTP ${response.status}, code ${failure.data?.code ?? "unknown"}`);
  }

  return z.object({ sid: z.string() }).parse(await response.json()).sid;
}
