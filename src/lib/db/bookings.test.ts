import { describe, expect, it } from "vitest";
import { formatRange, parseRange } from "./bookings";

describe("parseRange", () => {
  it("reads a range the way Postgres prints it", () => {
    const { start, end } = parseRange('["2030-01-07 15:00:00+00","2030-01-07 16:00:00+00")');
    expect(start.toISOString()).toBe("2030-01-07T15:00:00.000Z");
    expect(end.toISOString()).toBe("2030-01-07T16:00:00.000Z");
  });

  it("reads an offset with minutes", () => {
    expect(parseRange('["2030-01-07 15:00:00+05:30","2030-01-07 16:00:00+05:30")').start.toISOString()).toBe("2030-01-07T09:30:00.000Z");
  });

  it("refuses something it can't read", () => {
    expect(() => parseRange("empty")).toThrow();
  });
});

describe("formatRange", () => {
  it("uses the half-open bounds the table requires", () => {
    expect(formatRange(new Date("2030-01-07T15:00:00Z"), new Date("2030-01-07T16:00:00Z"))).toBe(
      "[2030-01-07T15:00:00.000Z,2030-01-07T16:00:00.000Z)",
    );
  });
});
