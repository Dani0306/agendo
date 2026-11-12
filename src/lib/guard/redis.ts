import "server-only";
import { Redis } from "@upstash/redis";

/** Null when Upstash isn't configured. Callers decide whether that is allowed. */
export function redisFromEnv(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? new Redis({ url, token }) : null;
}
