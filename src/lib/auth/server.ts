import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { z } from "zod";

const AuthEnvSchema = z.object({
  SUPABASE_URL: z.url(),
  /** Public by design, but kept server-only: the browser never talks to Supabase here. */
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  /** Where magic links send the owner back to. Must be on the project's redirect allow-list. */
  SITE_URL: z.url(),
});

export function authEnv() {
  return AuthEnvSchema.parse(process.env);
}

/**
 * A client acting as the signed-in owner, so RLS decides what they can read. One per
 * request: it carries that request's cookies. Never the secret key.
 */
export async function sessionClient() {
  const env = authEnv();
  const jar = await cookies();
  return createServerClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
    db: { schema: "agendo" },
    cookies: {
      getAll: () => jar.getAll(),
      setAll: (list) => {
        try {
          for (const cookie of list) jar.set(cookie.name, cookie.value, cookie.options);
        } catch {
          // Server Components can't write cookies; the proxy refreshes the session instead.
        }
      },
    },
  });
}

export type SessionClient = Awaited<ReturnType<typeof sessionClient>>;

/** Verifies the token's signature (getClaims), never just reads the cookie (getSession). */
export async function signedInUserId(client: SessionClient): Promise<string | null> {
  const { data } = await client.auth.getClaims();
  const subject = data?.claims?.sub;
  return typeof subject === "string" ? subject : null;
}
