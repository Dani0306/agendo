// Removes eval clinics a crashed run left behind. Matches only the eval tenant's name
// and receiving-number prefix, never the demo clinic. `npm run eval:cleanup`
import { db } from "@/lib/db/client";
import { unwrap } from "@/lib/db/unwrap";
import { dropEvalTenant } from "./seed";

async function main() {
  const client = db();
  const leftovers = unwrap(
    await client.from("tenants").select("id").eq("name", "Fisio Aurora (eval)").like("receiving_number", "whatsapp:+1990%"),
  ) as { id: string }[];
  for (const tenant of leftovers) await dropEvalTenant(client, tenant.id);
  console.log(`Removed ${leftovers.length} leftover eval clinics.`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
