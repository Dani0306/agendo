import "server-only";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { dbSink } from "@/lib/calls/sinks";
import { agentData } from "@/lib/db/agent-data";
import { bookingStore } from "@/lib/db/bookings";
import { db } from "@/lib/db/client";
import { conversationStore } from "@/lib/db/conversations";
import { PRIMARY_MODEL } from "@/lib/models";
import { loadPiiSecrets } from "@/lib/pii/phone";
import type { InboundDeps } from "./handle-inbound";
import { type AgentDeps, runAgent } from "./loop";

/** Fits inside Twilio's 15 seconds, because the reply travels in the webhook response. */
export const WHATSAPP_DEADLINE_MS = 12_000;
export const WEB_DEADLINE_MS = 25_000;

const WebhookEnvSchema = z.object({
  TWILIO_AUTH_TOKEN: z.string().min(1),
  TWILIO_WEBHOOK_URL: z.url(),
});

const CoreEnvSchema = z.object({ PRIVACY_POLICY_URL: z.url() });

const DemoEnvSchema = z.object({
  DEMO_CHAT_ENABLED: z.string().optional(),
  DEMO_RECEIVING_NUMBER: z.string().optional(),
});

export function webhookConfig() {
  const env = WebhookEnvSchema.parse(process.env);
  return { authToken: env.TWILIO_AUTH_TOKEN, webhookUrl: env.TWILIO_WEBHOOK_URL };
}

/** Null unless the demo is switched on. It has no rate limit or daily cap until T16 and T17. */
export function demoConfig(): { receivingNumber: string } | null {
  const env = DemoEnvSchema.parse(process.env);
  if (env.DEMO_CHAT_ENABLED !== "1" || !env.DEMO_RECEIVING_NUMBER) return null;
  return { receivingNumber: env.DEMO_RECEIVING_NUMBER };
}

/** Wires the real database, model and secrets into the core. */
export function inboundDeps(deadlineMs: number): Omit<InboundDeps, "send"> {
  const env = CoreEnvSchema.parse(process.env);
  const client = db();
  const now = () => new Date();
  const log: InboundDeps["log"] = (event, fields) => console.info(JSON.stringify({ event, ...fields }));

  const agent: AgentDeps = {
    model: openai(PRIMARY_MODEL),
    modelId: PRIMARY_MODEL,
    bookings: bookingStore(client),
    data: agentData(client),
    record: { sink: dbSink(client) },
    now,
    log,
  };

  return {
    store: conversationStore(client),
    agent: (turn) => runAgent(agent, { ...turn, deadlineMs }),
    secrets: loadPiiSecrets(),
    privacyUrl: env.PRIVACY_POLICY_URL,
    now,
    log,
  };
}
