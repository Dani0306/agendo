"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { authEnv, sessionClient } from "@/lib/auth/server";

const EmailSchema = z.email().max(320);

/**
 * Sends a magic link only to people who already have access (shouldCreateUser: false).
 * Every outcome shows the same "check your inbox", so the page doesn't reveal who has access.
 */
export async function requestMagicLink(form: FormData) {
  const email = EmailSchema.safeParse(String(form.get("email") ?? "").trim().toLowerCase());
  if (email.success) {
    const client = await sessionClient();
    await client.auth.signInWithOtp({
      email: email.data,
      options: { shouldCreateUser: false, emailRedirectTo: `${authEnv().SITE_URL}/auth/callback` },
    });
  }
  redirect("/dashboard/login?sent=1");
}

export async function signOut() {
  const client = await sessionClient();
  await client.auth.signOut();
  redirect("/dashboard/login");
}
