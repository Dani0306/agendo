import "server-only";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

const EnvSchema = z.object({
  SUPABASE_URL: z.url(),
  SUPABASE_SECRET_KEY: z.string().min(1),
});

/**
 * Server-only client with the secret key, scoped to schema `agendo`. It bypasses
 * RLS, so every tenant-scoped query must filter by tenant_id itself.
 */
export function db() {
  const env = EnvSchema.parse(process.env);
  return createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    db: { schema: "agendo" },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export type Db = ReturnType<typeof db>;
