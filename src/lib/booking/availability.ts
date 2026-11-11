import { addDays, isoWeekday, localToUtc, utcToLocal } from "./timezone";

export const SLOT_STEP_MINUTES = 30;

export type Resource = { id: string; name: string };
/** `opens` and `closes` are local "HH:MM" times. weekday is ISO: 1 Monday, 7 Sunday. */
export type WeeklyRule = { resourceId: string; weekday: number; opens: string; closes: string };
/** A null resourceId closes the whole clinic that day. */
export type Closure = { resourceId: string | null; date: string };
export type BusyPeriod = { resourceId: string; start: Date; end: Date };

export type Schedule = {
  timezone: string;
  resources: Resource[];
  rules: WeeklyRule[];
  closures: Closure[];
};

export type Slot = { date: string; time: string; start: Date; end: Date; resourceId: string; resourceName: string };

function minutes(clock: string): number {
  return Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
}

function clock(total: number): string {
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function isClosed(schedule: Schedule, resourceId: string, date: string): boolean {
  return schedule.closures.some(
    (closure) => closure.date === date && (closure.resourceId === null || closure.resourceId === resourceId),
  );
}

function overlaps(start: Date, end: Date, busy: BusyPeriod): boolean {
  return start < busy.end && busy.start < end;
}

/** Free start times on one local date, across resources, earliest first. */
export function slotsForDate(
  schedule: Schedule,
  busy: BusyPeriod[],
  request: { date: string; durationMinutes: number; now: Date; stepMinutes?: number },
): Slot[] {
  const step = request.stepMinutes ?? SLOT_STEP_MINUTES;
  const weekday = isoWeekday(request.date);
  const slots: Slot[] = [];

  for (const resource of schedule.resources) {
    if (isClosed(schedule, resource.id, request.date)) continue;
    const rules = schedule.rules.filter((rule) => rule.resourceId === resource.id && rule.weekday === weekday);

    for (const rule of rules) {
      const last = minutes(rule.closes) - request.durationMinutes;
      for (let at = minutes(rule.opens); at <= last; at += step) {
        const time = clock(at);
        const converted = localToUtc({ date: request.date, time }, schedule.timezone);
        if (!converted.ok || converted.at <= request.now) continue;

        const start = converted.at;
        const end = new Date(start.getTime() + request.durationMinutes * 60_000);
        const taken = busy.some((period) => period.resourceId === resource.id && overlaps(start, end, period));
        if (!taken) slots.push({ date: request.date, time, start, end, resourceId: resource.id, resourceName: resource.name });
      }
    }
  }

  return slots.sort((a, b) => a.start.getTime() - b.start.getTime() || a.resourceName.localeCompare(b.resourceName));
}

export type TimeRefusal = "invalid_time" | "ambiguous_time" | "past" | "closed" | "outside_hours";

export type TimeCheck =
  | { ok: true; start: Date; end: Date; resourceIds: string[] }
  | { ok: false; reason: TimeRefusal };

/**
 * Whether the clinic can see someone at a local time, ignoring existing bookings.
 * Whether the slot is free is left to the database.
 */
export function checkRequestedTime(
  schedule: Schedule,
  request: { date: string; time: string; durationMinutes: number; now: Date },
): TimeCheck {
  const converted = localToUtc({ date: request.date, time: request.time }, schedule.timezone);
  if (!converted.ok) return { ok: false, reason: converted.reason === "ambiguous" ? "ambiguous_time" : "invalid_time" };
  if (converted.at <= request.now) return { ok: false, reason: "past" };

  const notClosed = schedule.resources.filter((resource) => !isClosed(schedule, resource.id, request.date));
  if (notClosed.length === 0) return { ok: false, reason: "closed" };

  const weekday = isoWeekday(request.date);
  const from = minutes(request.time);
  const until = from + request.durationMinutes;
  const resourceIds = notClosed
    .filter((resource) =>
      schedule.rules.some(
        (rule) =>
          rule.resourceId === resource.id &&
          rule.weekday === weekday &&
          minutes(rule.opens) <= from &&
          until <= minutes(rule.closes),
      ),
    )
    .map((resource) => resource.id);

  if (resourceIds.length === 0) {
    const openThatDay = schedule.rules.some((rule) => rule.weekday === weekday);
    return { ok: false, reason: openThatDay ? "outside_hours" : "closed" };
  }

  return { ok: true, start: converted.at, end: new Date(converted.at.getTime() + request.durationMinutes * 60_000), resourceIds };
}

/** The first date from `fromDate` with any free slot, looking at most `days` ahead. */
export function nextDateWithSlots(
  schedule: Schedule,
  busy: BusyPeriod[],
  request: { fromDate: string; durationMinutes: number; now: Date; days: number },
): Slot[] {
  for (let offset = 0; offset < request.days; offset += 1) {
    const slots = slotsForDate(schedule, busy, {
      date: addDays(request.fromDate, offset),
      durationMinutes: request.durationMinutes,
      now: request.now,
    });
    if (slots.length > 0) return slots;
  }
  return [];
}

/** Today's local date in the tenant's zone. */
export function localToday(now: Date, timezone: string): string {
  return utcToLocal(now, timezone).date;
}
