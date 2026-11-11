import { describe, expect, it } from "vitest";
import { AGENDO_TABLES, checkTables } from "./smoke";
import { DbError, unwrap } from "./unwrap";

describe("unwrap", () => {
  it("returns the data, including an empty list", () => {
    expect(unwrap({ data: [], error: null })).toEqual([]);
  });

  it("throws on a permission error instead of returning nothing", () => {
    expect(() => unwrap({ data: null, error: { code: "42501", message: "permission denied" } })).toThrow(DbError);
  });

  it("throws when there is neither data nor an error", () => {
    expect(() => unwrap({ data: null, error: null })).toThrow(DbError);
  });
});

describe("checkTables", () => {
  it("reports row counts for every table", async () => {
    const results = await checkTables(async () => ({ data: [], error: null, count: 3 }));
    expect(results).toHaveLength(AGENDO_TABLES.length);
    expect(results[0]).toEqual({ table: "tenants", rows: 3 });
  });

  it("reports an unexposed schema as an error, never as 0 rows", async () => {
    const results = await checkTables(async () => ({
      data: null,
      error: { code: "PGRST106", message: "Invalid schema: agendo" },
      count: null,
    }));
    expect(results.every((result) => "error" in result)).toBe(true);
    expect(results[0]).toEqual({ table: "tenants", error: "PGRST106: Invalid schema: agendo" });
  });
});
