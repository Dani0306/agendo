// Reads every agendo table with the secret key. Free, and needs the network, so it
// is not part of `npm test`. A permission or exposure problem prints as an error.
import { db } from "@/lib/db/client";
import { checkTables } from "@/lib/db/smoke";

async function main() {
  const client = db();
  const results = await checkTables((table) => client.from(table).select("*", { count: "exact" }).limit(0));

  for (const result of results) {
    console.log(`${result.table.padEnd(26)} ${"error" in result ? `ERROR ${result.error}` : `${result.rows} rows`}`);
  }

  const failed = results.filter((result) => "error" in result).length;
  if (failed > 0) {
    console.error(`\n${failed} of ${results.length} tables failed. Is the migration applied and agendo exposed in the API settings?`);
    process.exitCode = 1;
  }
}

void main();
