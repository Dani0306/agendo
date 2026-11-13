// Gives one person access to the demo clinic's dashboard. Run it with your own email:
//   npm run dashboard:invite -- you@example.com
// Creates the auth user if missing (pre-confirmed, so the magic link works at once) and
// adds them to tenant_members as owner. The email is never logged in full or committed.
import { z } from "zod";
import { db } from "@/lib/db/client";
import { unwrap } from "@/lib/db/unwrap";

function masked(email: string): string {
  const [name, domain] = email.split("@");
  return `${name!.slice(0, 2)}…@${domain}`;
}

async function findUserId(client: ReturnType<typeof db>, email: string): Promise<string | null> {
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: 100 });
    if (error) throw error;
    const user = data.users.find((candidate) => candidate.email?.toLowerCase() === email);
    if (user) return user.id;
    if (data.users.length < 100) return null;
  }
  return null;
}

async function main() {
  const email = z.email().parse(String(process.argv[2] ?? "").trim().toLowerCase());
  const number = z.string().min(1).parse(process.env.DEMO_RECEIVING_NUMBER);
  const client = db();

  const tenant = unwrap(await client.from("tenants").select("id, name").eq("receiving_number", number).single()) as { id: string; name: string };

  let userId = await findUserId(client, email);
  if (!userId) {
    const { data, error } = await client.auth.admin.createUser({ email, email_confirm: true });
    if (error) throw error;
    userId = data.user.id;
    console.log(`Created auth user ${masked(email)}`);
  } else {
    console.log(`Auth user ${masked(email)} already exists`);
  }

  unwrap(
    await client
      .from("tenant_members")
      .upsert({ tenant_id: tenant.id, user_id: userId, role: "owner" }, { onConflict: "tenant_id,user_id" })
      .select("tenant_id"),
  );
  console.log(`${masked(email)} is an owner of "${tenant.name}". Sign in at /dashboard/login.`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
