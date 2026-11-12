import "server-only";
import { createHmac } from "node:crypto";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { dbSink } from "@/lib/calls/sinks";
import { agentData } from "@/lib/db/agent-data";
import { bookingStore } from "@/lib/db/bookings";
import { modelSpendSince, postgresBudget } from "@/lib/db/budget";
import { db } from "@/lib/db/client";
import { conversationStore } from "@/lib/db/conversations";
import { DEMO_DAILY_CAP_USD } from "@/lib/guard/budget";
import { allowAll, CUSTOMER_WINDOWS, type RateLimiter, upstashLimiter, WEB_IP_WINDOWS } from "@/lib/guard/rate-limit";
import { redisFromEnv } from "@/lib/guard/redis";
import { noCache, type ResponseCache, upstashCache } from "@/lib/guard/response-cache";
import { PRIMARY_MODEL } from "@/lib/models";
import { loadPiiSecrets } from "@/lib/pii/phone";
import type { InboundDeps } from "./handle-inbound";
import { type AgentDeps, runAgent } from "./loop";
import { OVER_BUDGET_TEXT, staticReply } from "./reply";

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

const log: InboundDeps["log"] = (event, fields) => console.info(JSON.stringify({ event, ...fields }));

export function webhookConfig() {
  const env = WebhookEnvSchema.parse(process.env);
  return { authToken: env.TWILIO_AUTH_TOKEN, webhookUrl: env.TWILIO_WEBHOOK_URL };
}

/** Null unless the demo is switched on. */
export function demoConfig(): { receivingNumber: string } | null {
  const env = DemoEnvSchema.parse(process.env);
  if (env.DEMO_CHAT_ENABLED !== "1" || !env.DEMO_RECEIVING_NUMBER) return null;
  return { receivingNumber: env.DEMO_RECEIVING_NUMBER };
}

let warnedNoRedis = false;

/**
 * Rate limits need Redis. In development it may be missing, which turns them off with a
 * warning; a production server refuses to run without it.
 */
function limiterFor(prefix: string, windows: typeof CUSTOMER_WINDOWS): RateLimiter {
  const redis = redisFromEnv();
  if (redis) {
    return upstashLimiter(redis, prefix, windows, (error) =>
      log("ratelimit.redis_error", { prefix, error: String(error).slice(0, 200) }),
    );
  }
  if (process.env.NODE_ENV === "production") throw new Error("UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required");
  if (!warnedNoRedis) {
    warnedNoRedis = true;
    log("ratelimit.disabled", { reason: "no Upstash configuration" });
  }
  return allowAll;
}

function responseCache(): ResponseCache {
  const redis = redisFromEnv();
  return redis ? upstashCache(redis, (error) => log("cache.redis_error", { error: String(error).slice(0, 200) })) : noCache;
}

/** Keyed by a hash, so Redis never holds a visitor's IP address. */
export function webIpLimiter(): { check(ip: string): ReturnType<RateLimiter["check"]> } {
  const limiter = limiterFor("ip", WEB_IP_WINDOWS);
  const pepper = loadPiiSecrets().pepper;
  return { check: (ip) => limiter.check(createHmac("sha256", pepper).update(`ip:${ip}`).digest("hex")) };
}

/** Wires the real database, model, guards and secrets into the core. */
export function inboundDeps(
  deadlineMs: number,
  options: { demoCap?: boolean; promptCache?: AgentDeps["promptCache"]; responseCache?: boolean } = {},
): Omit<InboundDeps, "send"> {
  const env = CoreEnvSchema.parse(process.env);
  const client = db();
  const now = () => new Date();

  const agentDeps: AgentDeps = {
    model: openai(PRIMARY_MODEL),
    modelId: PRIMARY_MODEL,
    bookings: bookingStore(client),
    data: agentData(client),
    record: { sink: dbSink(client) },
    budget: postgresBudget(client),
    cache: options.responseCache === false ? noCache : responseCache(),
    promptCache: options.promptCache,
    now,
    log,
  };

  const agent: InboundDeps["agent"] = async (turn) => {
    if (options.demoCap) {
      // The public demo's cap across all visitors, counted from model_calls (UTC day).
      const dayStart = new Date(now().toISOString().slice(0, 10) + "T00:00:00Z");
      if ((await modelSpendSince(client, turn.tenantId, dayStart)) >= DEMO_DAILY_CAP_USD) {
        log("agent.demo_cap", { tenantId: turn.tenantId });
        return staticReply(OVER_BUDGET_TEXT, "over_budget");
      }
    }
    return runAgent(agentDeps, { ...turn, deadlineMs });
  };

  return {
    store: conversationStore(client),
    agent,
    limiter: limiterFor("customer", CUSTOMER_WINDOWS),
    secrets: loadPiiSecrets(),
    privacyUrl: env.PRIVACY_POLICY_URL,
    now,
    log,
  };
}
