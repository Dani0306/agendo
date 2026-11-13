import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { sessionClient } from "@/lib/auth/server";

/**
 * Where the magic link lands. The default email template returns a PKCE `code`; a
 * template that sends `token_hash` works too. The shared project's template stays as is.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  const client = await sessionClient();

  const { error } = code
    ? await client.auth.exchangeCodeForSession(code)
    : tokenHash && type
      ? await client.auth.verifyOtp({ token_hash: tokenHash, type })
      : { error: new Error("missing code") };

  return NextResponse.redirect(new URL(error ? "/dashboard/login?error=1" : "/dashboard", url.origin));
}
