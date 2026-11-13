import { describe, expect, it } from "vitest";
import { customerLabel, formatUsd, percentile, perLocalDay } from "./metrics";

describe("percentile", () => {
  it("uses the nearest rank", () => {
    const values = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    expect(percentile(values, 50)).toBe(500);
    expect(percentile(values, 95)).toBe(1000);
    expect(percentile([42], 95)).toBe(42);
  });

  it("is null with nothing to measure", () => {
    expect(percentile([], 50)).toBeNull();
  });
});

describe("perLocalDay", () => {
  // 02:00 UTC on 11 Nov is 21:00 on 10 Nov in Bogota.
  const now = new Date("2026-11-11T15:00:00Z");
  const rows = [
    { at: "2026-11-11T02:00:00Z", cost: 0.25 },
    { at: "2026-11-10T20:00:00Z", cost: 0.5 },
    { at: "2026-11-11T14:00:00Z", cost: 1 },
    { at: "2026-10-01T14:00:00Z", cost: 9 },
  ];

  it("counts by the tenant's day, not the UTC day, and keeps empty days", () => {
    expect(perLocalDay(rows, { timezone: "America/Bogota", now, days: 3, at: (row) => row.at })).toEqual([
      { date: "2026-11-09", total: 0 },
      { date: "2026-11-10", total: 2 },
      { date: "2026-11-11", total: 1 },
    ]);
  });

  it("can sum a value instead of counting", () => {
    const days = perLocalDay(rows, { timezone: "America/Bogota", now, days: 2, at: (row) => row.at, value: (row) => row.cost });
    expect(days).toEqual([
      { date: "2026-11-10", total: 0.75 },
      { date: "2026-11-11", total: 1 },
    ]);
  });
});

describe("customerLabel", () => {
  it("shows a name, or a short id, never anything like a phone", () => {
    expect(customerLabel({ id: "c-0000-1234", display_name: "Ana" })).toBe("Ana");
    expect(customerLabel({ id: "c-0000-1234", display_name: null })).toBe("Paciente ·1234");
    expect(customerLabel({ id: "c-0000-1234", display_name: "  " })).toBe("Paciente ·1234");
    expect(customerLabel(null)).toBe("Paciente");
  });
});

describe("formatUsd", () => {
  it("shows fractions of a cent for small amounts", () => {
    expect(formatUsd(0.00066)).toBe("$0.0007");
    expect(formatUsd(3.5)).toBe("$3.50");
  });
});
