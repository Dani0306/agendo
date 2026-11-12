import { createHash } from "node:crypto";
import type { Redis } from "@upstash/redis";

/** A day at most, and the key also carries the local date, so "¿atienden hoy?" can't go stale. */
export const RESPONSE_TTL_SECONDS = 86_400;
const MIN_WORDS = 3;

/**
 * Words that suggest a booking or a customer's own appointment. Those answers depend on
 * live availability or on who is asking, so they are never cached, even when the model
 * happened to answer without a tool. Deliberately broad: a miss only costs a model call.
 */
const BOOKING_STEMS = ["agend", "cita", "reserv", "cancel", "reprogram", "cambi", "mover", "cupo", "disponib", "turno", "book", "appointment"];

export type ResponseCache = {
  get(key: string): Promise<string | null>;
  set(key: string, text: string, ttlSeconds: number): Promise<void>;
};

export const noCache: ResponseCache = { get: async () => null, set: async () => undefined };

export function normalizeQuestion(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function isCacheableQuestion(text: string): boolean {
  const normalized = normalizeQuestion(text);
  if (normalized.split(" ").filter(Boolean).length < MIN_WORDS) return false;
  return !BOOKING_STEMS.some((stem) => normalized.includes(stem));
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Changes whenever the FAQ, services, prices or hours change, which invalidates every entry. */
export function tenantVersion(tenant: { faq: unknown; services: unknown; hours: unknown }): string {
  return sha256(JSON.stringify([tenant.faq, tenant.services, tenant.hours])).slice(0, 16);
}

/** The question is hashed, so health details a patient typed never become a readable key. */
export function cacheKey(parts: { tenantId: string; version: string; localDate: string; question: string }): string {
  return `agendo:faq:v1:${parts.tenantId}:${parts.version}:${parts.localDate}:${sha256(normalizeQuestion(parts.question))}`;
}

/** Any Redis failure is a miss: the cache only ever saves money, never blocks a reply. */
export function upstashCache(redis: Redis, onError: (error: unknown) => void): ResponseCache {
  return {
    async get(key) {
      try {
        const value = await redis.get<string>(key);
        return typeof value === "string" ? value : null;
      } catch (error) {
        onError(error);
        return null;
      }
    },
    async set(key, text, ttlSeconds) {
      try {
        await redis.set(key, text, { ex: ttlSeconds });
      } catch (error) {
        onError(error);
      }
    },
  };
}
