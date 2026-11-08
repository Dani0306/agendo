type SupabaseError = { message: string; code?: string };

export class DbError extends Error {
  readonly code: string | undefined;

  constructor(error: SupabaseError) {
    super(`${error.code ?? "unknown"}: ${error.message}`);
    this.name = "DbError";
    this.code = error.code;
  }
}

/**
 * Returns a query's rows or throws. supabase-js reports failures in the result
 * instead of throwing, so without this a missing grant can pass for an empty table.
 */
export function unwrap<T>(result: { data: T | null; error: SupabaseError | null }): T {
  if (result.error) throw new DbError(result.error);
  if (result.data === null) throw new DbError({ message: "Query returned no data", code: "NO_DATA" });
  return result.data;
}
