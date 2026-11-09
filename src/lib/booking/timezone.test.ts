import { describe, expect, it } from "vitest";
import { addDays, isoWeekday, localToUtc, spanishDate, spanishTime, utcToLocal } from "./timezone";

const NEW_YORK = "America/New_York";
const BOGOTA = "America/Bogota";

function at(result: ReturnType<typeof localToUtc>): string {
  if (!result.ok) throw new Error(result.reason);
  return result.at.toISOString();
}

describe("localToUtc", () => {
  it("converts Bogota, which is always UTC-5", () => {
    expect(at(localToUtc({ date: "2026-11-10", time: "15:00" }, BOGOTA))).toBe("2026-11-10T20:00:00.000Z");
  });

  it("uses the offset in force on that date in a DST zone", () => {
    expect(at(localToUtc({ date: "2026-07-15", time: "09:00" }, NEW_YORK))).toBe("2026-07-15T13:00:00.000Z");
    expect(at(localToUtc({ date: "2026-12-15", time: "09:00" }, NEW_YORK))).toBe("2026-12-15T14:00:00.000Z");
  });

  it("converts correctly on the day of a change, away from the change itself", () => {
    expect(at(localToUtc({ date: "2026-03-08", time: "01:00" }, NEW_YORK))).toBe("2026-03-08T06:00:00.000Z");
    expect(at(localToUtc({ date: "2026-03-08", time: "09:00" }, NEW_YORK))).toBe("2026-03-08T13:00:00.000Z");
  });

  it("refuses a time skipped by the spring change", () => {
    expect(localToUtc({ date: "2026-03-08", time: "02:30" }, NEW_YORK)).toEqual({ ok: false, reason: "nonexistent" });
  });

  it("refuses a time repeated by the autumn change", () => {
    expect(localToUtc({ date: "2026-11-01", time: "01:30" }, NEW_YORK)).toEqual({ ok: false, reason: "ambiguous" });
  });

  it.each([
    ["2026-02-30", "10:00"],
    ["2026-13-01", "10:00"],
    ["2026-11-10", "25:00"],
    ["2026-11-10", "10:60"],
    ["el martes", "10:00"],
  ])("refuses the malformed value %s %s", (date, time) => {
    expect(localToUtc({ date, time }, BOGOTA)).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("utcToLocal", () => {
  it("returns the local date, which can differ from the UTC date", () => {
    expect(utcToLocal(new Date("2026-11-11T02:00:00Z"), BOGOTA)).toEqual({ date: "2026-11-10", time: "21:00" });
  });

  it("round-trips through localToUtc in a DST zone", () => {
    const local = { date: "2026-07-15", time: "09:30" };
    const converted = localToUtc(local, NEW_YORK);
    if (!converted.ok) throw new Error(converted.reason);
    expect(utcToLocal(converted.at, NEW_YORK)).toEqual(local);
  });
});

describe("calendar helpers", () => {
  it("numbers weekdays from Monday", () => {
    expect(isoWeekday("2026-11-09")).toBe(1);
    expect(isoWeekday("2026-11-15")).toBe(7);
  });

  it("adds days across a month end", () => {
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
  });

  it("writes dates and times for customers", () => {
    expect(spanishDate("2026-11-10")).toBe("martes 10 de noviembre de 2026");
    expect(spanishTime("15:00")).toBe("3:00 p. m.");
  });
});
