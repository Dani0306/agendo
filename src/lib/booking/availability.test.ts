import { describe, expect, it } from "vitest";
import { checkRequestedTime, localToday, nextDateWithSlots, type Schedule, slotsForDate } from "./availability";

// 2026-11-09 is a Monday. 12:00 UTC is 07:00 in Bogota.
const NOW = new Date("2026-11-09T12:00:00Z");
const TUESDAY = "2026-11-10";

const schedule: Schedule = {
  timezone: "America/Bogota",
  resources: [
    { id: "r1", name: "Laura" },
    { id: "r2", name: "Andrés" },
  ],
  rules: [
    { resourceId: "r1", weekday: 2, opens: "08:00", closes: "10:00" },
    { resourceId: "r2", weekday: 2, opens: "09:00", closes: "10:00" },
  ],
  closures: [],
};

const request = { date: TUESDAY, durationMinutes: 60, now: NOW };

function times(slots: { time: string; resourceName: string }[]) {
  return slots.map((slot) => `${slot.time} ${slot.resourceName}`);
}

describe("slotsForDate", () => {
  it("offers every start that fits before closing, across resources", () => {
    expect(times(slotsForDate(schedule, [], request))).toEqual(["08:00 Laura", "08:30 Laura", "09:00 Andrés", "09:00 Laura"]);
  });

  it("removes starts that overlap a booking on that resource only", () => {
    const busy = [{ resourceId: "r1", start: new Date("2026-11-10T14:00:00Z"), end: new Date("2026-11-10T15:00:00Z") }];
    expect(times(slotsForDate(schedule, busy, request))).toEqual(["08:00 Laura", "09:00 Andrés"]);
  });

  it("allows a booking to start exactly when another ends", () => {
    const busy = [{ resourceId: "r1", start: new Date("2026-11-10T13:00:00Z"), end: new Date("2026-11-10T14:00:00Z") }];
    expect(times(slotsForDate(schedule, busy, request))).toContain("09:00 Laura");
  });

  it("drops times already past today", () => {
    const now = new Date("2026-11-10T13:10:00Z"); // 08:10 in Bogota
    expect(times(slotsForDate(schedule, [], { ...request, now }))).toEqual(["08:30 Laura", "09:00 Andrés", "09:00 Laura"]);
  });

  it("respects a whole-clinic closure and a single-resource closure", () => {
    expect(slotsForDate({ ...schedule, closures: [{ resourceId: null, date: TUESDAY }] }, [], request)).toEqual([]);
    expect(times(slotsForDate({ ...schedule, closures: [{ resourceId: "r1", date: TUESDAY }] }, [], request))).toEqual(["09:00 Andrés"]);
  });

  it("returns nothing on a day with no rules", () => {
    expect(slotsForDate(schedule, [], { ...request, date: "2026-11-11" })).toEqual([]);
  });

  it("uses the local offset of a DST zone on each side of a change", () => {
    const nyc: Schedule = {
      timezone: "America/New_York",
      resources: [{ id: "r1", name: "Laura" }],
      rules: [
        { resourceId: "r1", weekday: 7, opens: "09:00", closes: "10:00" },
      ],
      closures: [],
    };
    const now = new Date("2026-01-01T00:00:00Z");
    const before = slotsForDate(nyc, [], { date: "2026-03-01", durationMinutes: 60, now });
    const after = slotsForDate(nyc, [], { date: "2026-03-08", durationMinutes: 60, now });
    expect(before[0]!.start.toISOString()).toBe("2026-03-01T14:00:00.000Z");
    expect(after[0]!.start.toISOString()).toBe("2026-03-08T13:00:00.000Z");
  });

  it("skips a start time that a DST change removes", () => {
    const nyc: Schedule = {
      timezone: "America/New_York",
      resources: [{ id: "r1", name: "Laura" }],
      rules: [{ resourceId: "r1", weekday: 7, opens: "02:00", closes: "04:00" }],
      closures: [],
    };
    const slots = slotsForDate(nyc, [], { date: "2026-03-08", durationMinutes: 30, now: new Date("2026-01-01T00:00:00Z") });
    expect(slots.map((slot) => slot.time)).toEqual(["03:00", "03:30"]);
  });
});

describe("checkRequestedTime", () => {
  const ask = (date: string, time: string, durationMinutes = 60, now = NOW) =>
    checkRequestedTime(schedule, { date, time, durationMinutes, now });

  it("returns the instants and the resources open at that time", () => {
    const check = ask(TUESDAY, "09:00");
    if (!check.ok) throw new Error(check.reason);
    expect(check.start.toISOString()).toBe("2026-11-10T14:00:00.000Z");
    expect(check.end.toISOString()).toBe("2026-11-10T15:00:00.000Z");
    expect(check.resourceIds.sort()).toEqual(["r1", "r2"]);
  });

  it("excludes a resource that opens later", () => {
    const check = ask(TUESDAY, "08:00");
    if (!check.ok) throw new Error(check.reason);
    expect(check.resourceIds).toEqual(["r1"]);
  });

  it.each([
    [TUESDAY, "07:00", "outside_hours"],
    [TUESDAY, "09:30", "outside_hours"], // would end after closing
    ["2026-11-11", "09:00", "closed"],
    ["2026-11-02", "09:00", "past"],
    ["2026-02-30", "09:00", "invalid_time"],
  ])("refuses %s %s as %s", (date, time, reason) => {
    expect(ask(date, time)).toEqual({ ok: false, reason });
  });

  it("refuses a closed date", () => {
    const closed = { ...schedule, closures: [{ resourceId: null, date: TUESDAY }] };
    expect(checkRequestedTime(closed, { date: TUESDAY, time: "09:00", durationMinutes: 60, now: NOW })).toEqual({ ok: false, reason: "closed" });
  });

  it("refuses an ambiguous time in a DST zone", () => {
    const nyc: Schedule = {
      timezone: "America/New_York",
      resources: [{ id: "r1", name: "Laura" }],
      rules: [{ resourceId: "r1", weekday: 7, opens: "01:00", closes: "03:00" }],
      closures: [],
    };
    expect(
      checkRequestedTime(nyc, { date: "2026-11-01", time: "01:30", durationMinutes: 30, now: new Date("2026-01-01T00:00:00Z") }),
    ).toEqual({ ok: false, reason: "ambiguous_time" });
  });
});

describe("nextDateWithSlots", () => {
  it("skips empty days and stops at the first with slots", () => {
    const slots = nextDateWithSlots(schedule, [], { fromDate: "2026-11-11", durationMinutes: 60, now: NOW, days: 7 });
    expect(slots[0]!.date).toBe("2026-11-17");
  });

  it("gives up after the limit", () => {
    expect(nextDateWithSlots(schedule, [], { fromDate: "2026-11-11", durationMinutes: 60, now: NOW, days: 3 })).toEqual([]);
  });
});

describe("localToday", () => {
  it("is the tenant's date, not the UTC date", () => {
    expect(localToday(new Date("2026-11-10T02:00:00Z"), "America/Bogota")).toBe("2026-11-09");
  });
});
