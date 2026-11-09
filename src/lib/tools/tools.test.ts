import { describe, expect, it } from "vitest";
import type { Schedule } from "@/lib/booking/availability";
import { fakeStore } from "./fake-store";
import { TOOLS, type ToolContext, type ToolOutcome, usesWriteAttempt } from "./tools";

// 2026-11-09 is a Monday, 07:00 in Bogota.
const NOW = new Date("2026-11-09T12:00:00Z");
const TUESDAY = "2026-11-10";

const schedule: Schedule = {
  timezone: "America/Bogota",
  resources: [
    { id: "laura", name: "Laura" },
    { id: "andres", name: "Andrés" },
  ],
  rules: [1, 2, 3, 4, 5].flatMap((weekday) => [
    { resourceId: "laura", weekday, opens: "08:00", closes: "12:00" },
    { resourceId: "andres", weekday, opens: "08:00", closes: "12:00" },
  ]),
  closures: [{ resourceId: null, date: "2026-11-11" }],
};

const services = [
  { id: "val", name: "Valoración inicial", durationMinutes: 60 },
  { id: "ses", name: "Sesión de fisioterapia", durationMinutes: 45 },
  { id: "reh", name: "Sesión de rehabilitación deportiva", durationMinutes: 60 },
];

function setup() {
  const fake = fakeStore(schedule, services);
  const ctx = (customerId = "ana", tenantId = "t1"): ToolContext => ({
    tenantId,
    customerId,
    conversationId: "c1",
    now: NOW,
    store: fake.store,
  });
  return { ...fake, ctx };
}

type Out = ToolOutcome & Record<string, never>;
const run = (name: keyof typeof TOOLS, ctx: ToolContext, input: unknown) => TOOLS[name].run(ctx, input) as Promise<Out>;
const book = (ctx: ToolContext, time: string, extra: object = {}) =>
  run("create_booking", ctx, { service: "Valoración inicial", date: TUESDAY, time, ...extra });

describe("create_booking", () => {
  it("books and reports the row with local time and timezone", async () => {
    const { rows, ctx } = setup();
    const outcome = await book(ctx(), "09:00");
    expect(outcome).toMatchObject({
      status: "booked",
      booking: {
        service: "Valoración inicial",
        professional: "Laura",
        date: TUESDAY,
        time: "09:00",
        timezone: "America/Bogota",
        dateText: "martes 10 de noviembre de 2026",
      },
    });
    expect(rows[0]!.start.toISOString()).toBe("2026-11-10T14:00:00.000Z");
  });

  it("matches service names without accents or the full name", async () => {
    const { ctx } = setup();
    expect(await run("create_booking", ctx(), { service: "valoracion", date: TUESDAY, time: "09:00" })).toMatchObject({ status: "booked" });
  });

  it("treats a name matching several services as unknown and lists them", async () => {
    const { rows, ctx } = setup();
    const outcome = await run("create_booking", ctx(), { service: "sesión", date: TUESDAY, time: "09:00" });
    expect(outcome.status).toBe("unknown_service");
    expect(outcome.services).toHaveLength(3);
    expect(rows).toHaveLength(0);
  });

  it("moves to the next therapist when the first is taken", async () => {
    const { ctx } = setup();
    await book(ctx("ana"), "09:00");
    expect(await book(ctx("luis"), "09:00")).toMatchObject({ status: "booked", booking: { professional: "Andrés" } });
  });

  it("returns slot_taken with alternatives when every therapist is taken", async () => {
    const { ctx } = setup();
    await book(ctx("ana"), "09:00");
    await book(ctx("luis"), "09:00");
    const outcome = await book(ctx("eva"), "09:00");
    expect(outcome.status).toBe("slot_taken");
    expect(outcome.alternatives).not.toHaveLength(0);
    expect((outcome.alternatives as unknown as { time: string }[]).map((slot) => slot.time)).not.toContain("09:00");
  });

  it("honours a named therapist and reports when that one is taken", async () => {
    const { ctx } = setup();
    await book(ctx("ana"), "09:00", { professional: "Laura" });
    expect((await book(ctx("luis"), "09:00", { professional: "Laura" })).status).toBe("slot_taken");
  });

  it("refuses an unknown therapist without writing", async () => {
    const { rows, ctx } = setup();
    expect((await book(ctx(), "09:00", { professional: "Pedro" })).status).toBe("unknown_professional");
    expect(rows).toHaveLength(0);
  });

  it.each([
    [TUESDAY, "07:00", "outside_hours"],
    ["2026-11-11", "09:00", "closed"],
    ["2026-11-02", "09:00", "past"],
    ["2026-02-30", "09:00", "invalid_time"],
  ])("refuses %s %s as %s, with alternatives and no write", async (date, time, reason) => {
    const { rows, ctx } = setup();
    const outcome = await run("create_booking", ctx(), { service: "Valoración inicial", date, time });
    expect(outcome).toMatchObject({ status: "refused", reason });
    expect(outcome.alternatives).not.toHaveLength(0);
    expect(rows).toHaveLength(0);
  });

  it("won't double-book the same customer at an overlapping time", async () => {
    const { rows, ctx } = setup();
    await book(ctx(), "09:00");
    expect((await book(ctx(), "09:30")).status).toBe("already_booked");
    expect(rows).toHaveLength(1);
  });

  it("returns arguments that don't match the schema to the model, with no write", async () => {
    const { rows, ctx } = setup();
    expect(await run("create_booking", ctx(), { service: "Valoración inicial", date: "mañana", time: "09:00" })).toEqual({
      status: "invalid_arguments",
    });
    expect(rows).toHaveLength(0);
  });

  it("ignores any tenant or customer the model tries to pass", async () => {
    const { rows, ctx } = setup();
    await run("create_booking", ctx("ana"), {
      service: "Valoración inicial",
      date: TUESDAY,
      time: "09:00",
      tenantId: "t2",
      customerId: "someone-else",
    });
    expect(rows[0]).toMatchObject({ tenantId: "t1", customerId: "ana" });
  });
});

describe("check_availability", () => {
  it("lists each start time once, in local time", async () => {
    const { ctx } = setup();
    const outcome = await run("check_availability", ctx(), { service: "Valoración inicial", date: TUESDAY });
    expect(outcome).toMatchObject({ status: "available", timezone: "America/Bogota", day: "martes 10 de noviembre de 2026" });
    expect((outcome.times as unknown as { time: string }[]).map((slot) => slot.time)).toEqual([
      "08:00", "08:30", "09:00", "09:30", "10:00", "10:30", "11:00",
    ]);
  });

  it("removes a time only when every therapist is busy", async () => {
    const { ctx } = setup();
    await book(ctx("ana"), "09:00");
    const once = await run("check_availability", ctx(), { service: "Valoración inicial", date: TUESDAY });
    expect((once.times as unknown as { time: string }[]).map((slot) => slot.time)).toContain("09:00");
    await book(ctx("luis"), "09:00");
    const twice = await run("check_availability", ctx(), { service: "Valoración inicial", date: TUESDAY });
    expect((twice.times as unknown as { time: string }[]).map((slot) => slot.time)).not.toContain("09:00");
  });

  it("offers the nearest open day when the date is closed", async () => {
    const { ctx } = setup();
    const outcome = await run("check_availability", ctx(), { service: "Valoración inicial", date: "2026-11-11" });
    expect(outcome.status).toBe("none_that_day");
    expect((outcome.nearest as unknown as { date: string }[])[0]!.date).toBe("2026-11-12");
  });

  it("does not expose ids or customers", async () => {
    const { ctx } = setup();
    await book(ctx("ana"), "09:00");
    const text = JSON.stringify(await run("check_availability", ctx("luis"), { service: "Valoración inicial", date: TUESDAY }));
    expect(text).not.toContain("ana");
    expect(text).not.toContain("laura");
  });
});

describe("reschedule_booking", () => {
  it("moves the customer's booking and frees the old slot", async () => {
    const { rows, ctx } = setup();
    await book(ctx(), "09:00");
    const outcome = await run("reschedule_booking", ctx(), { current_date: TUESDAY, new_date: TUESDAY, new_time: "10:00" });
    expect(outcome).toMatchObject({ status: "rescheduled", booking: { time: "10:00", professional: "Laura" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.start.toISOString()).toBe("2026-11-10T15:00:00.000Z");
  });

  it("can shift by less than its own length", async () => {
    const { ctx } = setup();
    await book(ctx(), "09:00");
    expect((await run("reschedule_booking", ctx(), { current_date: TUESDAY, new_date: TUESDAY, new_time: "09:30" })).status).toBe("rescheduled");
  });

  it("keeps the original when the new slot is taken", async () => {
    const { rows, ctx } = setup();
    await book(ctx("ana"), "09:00");
    await book(ctx("luis"), "11:00");
    await book(ctx("eva"), "11:00");
    const outcome = await run("reschedule_booking", ctx("ana"), { current_date: TUESDAY, new_date: TUESDAY, new_time: "11:00" });
    expect(outcome.status).toBe("slot_taken");
    expect(rows[0]!.start.toISOString()).toBe("2026-11-10T14:00:00.000Z");
  });

  it("can't touch another customer's booking", async () => {
    const { rows, ctx } = setup();
    await book(ctx("ana"), "09:00");
    const outcome = await run("reschedule_booking", ctx("luis"), { current_date: TUESDAY, new_date: TUESDAY, new_time: "10:00" });
    expect(outcome.status).toBe("no_match");
    expect(rows[0]!.start.toISOString()).toBe("2026-11-10T14:00:00.000Z");
  });
});

describe("cancel_booking", () => {
  it("cancels only the customer's own booking and frees the slot", async () => {
    const { rows, ctx } = setup();
    await book(ctx("ana"), "09:00");
    expect((await run("cancel_booking", ctx("luis"), { date: TUESDAY })).status).toBe("no_match");
    expect(rows[0]!.status).toBe("confirmed");
    expect(await run("cancel_booking", ctx("ana"), { date: TUESDAY })).toMatchObject({ status: "cancelled", booking: { status: "cancelled" } });
    expect(rows[0]!.status).toBe("cancelled");
  });

  it("asks which one when two bookings share a date, then accepts a time", async () => {
    const { rows, ctx } = setup();
    await book(ctx(), "09:00");
    await book(ctx(), "11:00");
    const outcome = await run("cancel_booking", ctx(), { date: TUESDAY });
    expect(outcome.status).toBe("ambiguous");
    expect(outcome.bookings).toHaveLength(2);
    expect(rows.every((row) => row.status === "confirmed")).toBe(true);
    expect((await run("cancel_booking", ctx(), { date: TUESDAY, time: "11:00" })).status).toBe("cancelled");
  });
});

describe("my_bookings", () => {
  it("lists only this customer's bookings in this tenant", async () => {
    const { ctx } = setup();
    await book(ctx("ana"), "09:00");
    await book(ctx("luis"), "10:00");
    await book(ctx("ana", "t2"), "11:00");
    const outcome = await run("my_bookings", ctx("ana"), {});
    expect(outcome.bookings).toHaveLength(1);
    expect(outcome.bookings).toMatchObject([{ time: "09:00" }]);
  });
});

describe("handoff_to_human", () => {
  it("marks the conversation from the server context", async () => {
    const { handoffs, ctx } = setup();
    expect(await run("handoff_to_human", ctx(), {})).toEqual({ status: "handoff" });
    expect(handoffs).toEqual(["c1"]);
  });
});

describe("usesWriteAttempt", () => {
  it("lets a mistyped name be retried, and nothing else", () => {
    expect(usesWriteAttempt({ status: "unknown_service" })).toBe(false);
    expect(usesWriteAttempt({ status: "unknown_professional" })).toBe(false);
    expect(usesWriteAttempt({ status: "invalid_arguments" })).toBe(false);
    expect(usesWriteAttempt({ status: "refused" })).toBe(true);
    expect(usesWriteAttempt({ status: "no_match" })).toBe(true);
  });
});
