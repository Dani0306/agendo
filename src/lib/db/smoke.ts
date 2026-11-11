import { DbError, unwrap } from "./unwrap";

export const AGENDO_TABLES = [
  "tenants",
  "tenant_members",
  "services",
  "resources",
  "availability_rules",
  "availability_exceptions",
  "customers",
  "bookings",
  "conversations",
  "messages",
  "model_calls",
  "tenant_usage",
  "reminders",
] as const;

export type TableCheck = { table: string; rows: number } | { table: string; error: string };

type CountResult = {
  data: unknown[] | null;
  error: { message: string; code?: string } | null;
  count: number | null;
};

/** Asks for zero rows with GET, because a HEAD response has no body to carry the error. */
export type CountRows = (table: string) => PromiseLike<CountResult>;

export async function checkTables(countRows: CountRows): Promise<TableCheck[]> {
  return Promise.all(
    AGENDO_TABLES.map(async (table): Promise<TableCheck> => {
      const result = await countRows(table);
      try {
        unwrap(result);
      } catch (error) {
        if (error instanceof DbError) return { table, error: error.message };
        throw error;
      }
      return { table, rows: result.count ?? 0 };
    }),
  );
}
