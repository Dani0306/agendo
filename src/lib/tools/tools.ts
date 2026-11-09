import { z } from "zod";
import {
  type BusyPeriod,
  checkRequestedTime,
  localToday,
  nextDateWithSlots,
  type Schedule,
  type Slot,
  slotsForDate,
  type TimeRefusal,
} from "@/lib/booking/availability";
import { addDays, spanishDate, spanishTime, utcToLocal } from "@/lib/booking/timezone";
import { type BookingEvidence, bookingEvidence, type SlotOption, slotOption } from "@/lib/agent/reply";
import type { BookingStore, Service, StoredBooking } from "./store";

const MAX_ALTERNATIVES = 5;
const MAX_SLOTS_SHOWN = 10;
const LOOK_AHEAD_DAYS = 14;

/** The server's facts about this turn. Nothing here comes from the model. */
export type ToolContext = {
  tenantId: string;
  customerId: string;
  conversationId: string;
  now: Date;
  store: BookingStore;
};

const LocalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Fecha local AAAA-MM-DD");
const LocalTime = z.string().regex(/^\d{2}:\d{2}$/).describe("Hora local en 24 horas, HH:MM");
const ServiceName = z.string().min(1).max(200).describe("Nombre del servicio, tal como aparece en la lista");
const ProfessionalName = z.string().min(1).max(200).describe("Nombre del profesional, solo si la persona lo pidió");

const CheckAvailabilityArgs = z.object({ service: ServiceName, date: LocalDate, professional: ProfessionalName.optional() });
const CreateBookingArgs = z.object({ service: ServiceName, date: LocalDate, time: LocalTime, professional: ProfessionalName.optional() });
const RescheduleBookingArgs = z.object({
  current_date: LocalDate.describe("Fecha actual de la cita que se va a mover"),
  current_time: LocalTime.optional().describe("Hora actual, si la persona tiene varias citas ese día"),
  new_date: LocalDate,
  new_time: LocalTime,
  professional: ProfessionalName.optional(),
});
const CancelBookingArgs = z.object({
  date: LocalDate.describe("Fecha de la cita que se va a cancelar"),
  time: LocalTime.optional().describe("Hora, si la persona tiene varias citas ese día"),
});
const NoArgs = z.object({});

export type ToolOutcome = { status: string; [key: string]: unknown };

/** Ends the turn with a reply built by code from what the database did. */
export type TerminalOutcome =
  | { status: "booked" | "rescheduled" | "cancelled"; booking: BookingEvidence }
  | { status: "slot_taken"; alternatives: SlotOption[] }
  | { status: "handoff" };

function normalize(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").trim().toLowerCase();
}

/** Exact match first, then a single partial match. Several partial matches is no match. */
function findByName<T extends { name: string }>(rows: T[], wanted: string): T | null {
  const name = normalize(wanted);
  const exact = rows.find((row) => normalize(row.name) === name);
  if (exact) return exact;
  const partial = rows.filter((row) => normalize(row.name).includes(name));
  return partial.length === 1 ? partial[0]! : null;
}

function evidenceOf(booking: StoredBooking, timezone: string, status: BookingEvidence["status"]): BookingEvidence {
  const local = utcToLocal(booking.start, timezone);
  return bookingEvidence({ service: booking.serviceName, professional: booking.resourceName, timezone, ...local }, status);
}

/** A window wide enough to cover those local dates in any timezone. */
function busyWindow(date: string, days: number): [Date, Date] {
  return [new Date(`${addDays(date, -1)}T00:00:00Z`), new Date(`${addDays(date, days + 1)}T00:00:00Z`)];
}

function onlyResource(schedule: Schedule, resourceId: string | undefined): Schedule {
  return resourceId ? { ...schedule, resources: schedule.resources.filter((row) => row.id === resourceId) } : schedule;
}

/** One option per start time, so three free therapists don't fill the list. */
function distinctTimes(slots: Slot[]): Slot[] {
  const seen = new Set<string>();
  return slots.filter((slot) => {
    const key = `${slot.date} ${slot.time}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function alternativesFor(
  ctx: ToolContext,
  schedule: Schedule,
  durationMinutes: number,
  fromDate: string,
  resourceId: string | undefined,
): Promise<SlotOption[]> {
  const today = localToday(ctx.now, schedule.timezone);
  const start = fromDate < today ? today : fromDate;
  const [from, to] = busyWindow(start, LOOK_AHEAD_DAYS);
  const busy = await ctx.store.busyPeriods(ctx.tenantId, from, to);
  const slots = nextDateWithSlots(onlyResource(schedule, resourceId), busy, {
    fromDate: start,
    durationMinutes,
    now: ctx.now,
    days: LOOK_AHEAD_DAYS,
  });
  return distinctTimes(slots)
    .slice(0, MAX_ALTERNATIVES)
    .map((slot) => slotOption({ date: slot.date, time: slot.time, professional: slot.resourceName }));
}

type Resolved<T> = { ok: true; value: T } | { ok: false; outcome: ToolOutcome };

function resolveService(services: Service[], wanted: string): Resolved<Service> {
  const service = findByName(services, wanted);
  if (service) return { ok: true, value: service };
  return { ok: false, outcome: { status: "unknown_service", services: services.map((row) => row.name) } };
}

function resolveProfessional(schedule: Schedule, wanted: string | undefined): Resolved<string | undefined> {
  if (!wanted) return { ok: true, value: undefined };
  const resource = findByName(schedule.resources, wanted);
  if (resource) return { ok: true, value: resource.id };
  return { ok: false, outcome: { status: "unknown_professional", professionals: schedule.resources.map((row) => row.name) } };
}

async function timeRefused(
  ctx: ToolContext,
  schedule: Schedule,
  reason: TimeRefusal,
  durationMinutes: number,
  date: string,
  resourceId: string | undefined,
): Promise<ToolOutcome> {
  const fromDate = reason === "invalid_time" ? localToday(ctx.now, schedule.timezone) : date;
  return { status: "refused", reason, alternatives: await alternativesFor(ctx, schedule, durationMinutes, fromDate, resourceId) };
}

function overlappingBooking(bookings: StoredBooking[], start: Date, end: Date, exceptId?: string): StoredBooking | undefined {
  return bookings.find((row) => row.id !== exceptId && start < row.end && row.start < end);
}

function matchBooking(
  bookings: StoredBooking[],
  timezone: string,
  date: string,
  time: string | undefined,
): { ok: true; booking: StoredBooking } | { ok: false; outcome: ToolOutcome } {
  const list = () => bookings.map((row) => evidenceOf(row, timezone, "confirmed"));
  const matches = bookings.filter((row) => {
    const local = utcToLocal(row.start, timezone);
    return local.date === date && (time === undefined || local.time === time);
  });
  if (matches.length === 1) return { ok: true, booking: matches[0]! };
  return { ok: false, outcome: { status: matches.length === 0 ? "no_match" : "ambiguous", bookings: list() } };
}

function preferFirst(ids: string[], first: string | undefined): string[] {
  return first && ids.includes(first) ? [first, ...ids.filter((id) => id !== first)] : ids;
}

async function checkAvailability(ctx: ToolContext, args: z.infer<typeof CheckAvailabilityArgs>): Promise<ToolOutcome> {
  const { schedule, services } = await ctx.store.catalog(ctx.tenantId);
  const service = resolveService(services, args.service);
  if (!service.ok) return service.outcome;
  const professional = resolveProfessional(schedule, args.professional);
  if (!professional.ok) return professional.outcome;

  const [from, to] = busyWindow(args.date, 1);
  const busy: BusyPeriod[] = await ctx.store.busyPeriods(ctx.tenantId, from, to);
  const scoped = onlyResource(schedule, professional.value);
  const durationMinutes = service.value.durationMinutes;
  const slots = distinctTimes(slotsForDate(scoped, busy, { date: args.date, durationMinutes, now: ctx.now }));

  if (slots.length === 0) {
    const next = addDays(args.date, 1);
    return {
      status: "none_that_day",
      date: args.date,
      nearest: await alternativesFor(ctx, schedule, durationMinutes, next, professional.value),
      timezone: schedule.timezone,
    };
  }

  return {
    status: "available",
    date: args.date,
    day: spanishDate(args.date),
    timezone: schedule.timezone,
    service: service.value.name,
    duration_minutes: durationMinutes,
    times: slots.slice(0, MAX_SLOTS_SHOWN).map((slot) => ({
      time: slot.time,
      label: spanishTime(slot.time),
    })),
    more_available: slots.length > MAX_SLOTS_SHOWN,
  };
}

async function createBooking(
  ctx: ToolContext,
  args: z.infer<typeof CreateBookingArgs>,
): Promise<ToolOutcome | TerminalOutcome> {
  const { schedule, services } = await ctx.store.catalog(ctx.tenantId);
  const service = resolveService(services, args.service);
  if (!service.ok) return service.outcome;
  const professional = resolveProfessional(schedule, args.professional);
  if (!professional.ok) return professional.outcome;

  const durationMinutes = service.value.durationMinutes;
  const check = checkRequestedTime(onlyResource(schedule, professional.value), { ...args, durationMinutes, now: ctx.now });
  if (!check.ok) return timeRefused(ctx, schedule, check.reason, durationMinutes, args.date, professional.value);

  const mine = await ctx.store.upcomingBookings(ctx.tenantId, ctx.customerId, ctx.now);
  const clash = overlappingBooking(mine, check.start, check.end);
  if (clash) return { status: "already_booked", booking: evidenceOf(clash, schedule.timezone, "confirmed") };

  // Postgres decides. A refusal on one therapist just moves on to the next.
  for (const resourceId of check.resourceIds) {
    const booking = await ctx.store.insertBooking({
      tenantId: ctx.tenantId,
      customerId: ctx.customerId,
      serviceId: service.value.id,
      resourceId,
      start: check.start,
      end: check.end,
    });
    if (booking) return { status: "booked", booking: evidenceOf(booking, schedule.timezone, "confirmed") };
  }

  return {
    status: "slot_taken",
    alternatives: await alternativesFor(ctx, schedule, durationMinutes, args.date, professional.value),
  };
}

async function rescheduleBooking(
  ctx: ToolContext,
  args: z.infer<typeof RescheduleBookingArgs>,
): Promise<ToolOutcome | TerminalOutcome> {
  const { schedule } = await ctx.store.catalog(ctx.tenantId);
  const mine = await ctx.store.upcomingBookings(ctx.tenantId, ctx.customerId, ctx.now);
  const matched = matchBooking(mine, schedule.timezone, args.current_date, args.current_time);
  if (!matched.ok) return matched.outcome;
  const professional = resolveProfessional(schedule, args.professional);
  if (!professional.ok) return professional.outcome;

  const booking = matched.booking;
  const durationMinutes = booking.serviceDurationMinutes;
  const check = checkRequestedTime(onlyResource(schedule, professional.value), {
    date: args.new_date,
    time: args.new_time,
    durationMinutes,
    now: ctx.now,
  });
  if (!check.ok) return timeRefused(ctx, schedule, check.reason, durationMinutes, args.new_date, professional.value);

  const clash = overlappingBooking(mine, check.start, check.end, booking.id);
  if (clash) return { status: "already_booked", booking: evidenceOf(clash, schedule.timezone, "confirmed") };

  const scope = { tenantId: ctx.tenantId, customerId: ctx.customerId, bookingId: booking.id };
  for (const resourceId of preferFirst(check.resourceIds, booking.resourceId)) {
    const moved = await ctx.store.moveBooking(scope, { resourceId, start: check.start, end: check.end });
    if (moved) return { status: "rescheduled", booking: evidenceOf(moved, schedule.timezone, "confirmed") };
  }

  return {
    status: "slot_taken",
    alternatives: await alternativesFor(ctx, schedule, durationMinutes, args.new_date, professional.value),
  };
}

async function cancelBooking(ctx: ToolContext, args: z.infer<typeof CancelBookingArgs>): Promise<ToolOutcome | TerminalOutcome> {
  const { schedule } = await ctx.store.catalog(ctx.tenantId);
  const mine = await ctx.store.upcomingBookings(ctx.tenantId, ctx.customerId, ctx.now);
  const matched = matchBooking(mine, schedule.timezone, args.date, args.time);
  if (!matched.ok) return matched.outcome;

  const scope = { tenantId: ctx.tenantId, customerId: ctx.customerId, bookingId: matched.booking.id };
  if (!(await ctx.store.cancelBooking(scope))) return { status: "no_match", bookings: [] };
  return { status: "cancelled", booking: evidenceOf(matched.booking, schedule.timezone, "cancelled") };
}

async function myBookings(ctx: ToolContext): Promise<ToolOutcome> {
  const { schedule } = await ctx.store.catalog(ctx.tenantId);
  const mine = await ctx.store.upcomingBookings(ctx.tenantId, ctx.customerId, ctx.now);
  return { status: "ok", bookings: mine.map((row) => evidenceOf(row, schedule.timezone, "confirmed")) };
}

async function handoffToHuman(ctx: ToolContext): Promise<TerminalOutcome> {
  await ctx.store.markHandoff(ctx.tenantId, ctx.conversationId);
  return { status: "handoff" };
}

type ToolRunner = (ctx: ToolContext, input: unknown) => Promise<ToolOutcome | TerminalOutcome>;

function define<S extends z.ZodType>(
  description: string,
  inputSchema: S,
  run: (ctx: ToolContext, args: z.infer<S>) => Promise<ToolOutcome | TerminalOutcome>,
  write = false,
) {
  const runner: ToolRunner = async (ctx, input) => {
    const parsed = inputSchema.safeParse(input);
    return parsed.success ? run(ctx, parsed.data) : { status: "invalid_arguments" };
  };
  return { description, inputSchema, run: runner, write };
}

export const TOOLS = {
  check_availability: define(
    "Consulta los horarios libres de un servicio en una fecha. Úsala antes de ofrecer cualquier horario.",
    CheckAvailabilityArgs,
    checkAvailability,
  ),
  create_booking: define(
    "Agenda una cita cuando la persona ya eligió servicio, fecha y hora. La base de datos decide si el horario sigue libre.",
    CreateBookingArgs,
    createBooking,
    true,
  ),
  reschedule_booking: define(
    "Mueve una cita existente de la persona a otra fecha y hora.",
    RescheduleBookingArgs,
    rescheduleBooking,
    true,
  ),
  cancel_booking: define("Cancela una cita de la persona, después de confirmar cuál.", CancelBookingArgs, cancelBooking, true),
  my_bookings: define("Lista las próximas citas de la persona que escribe.", NoArgs, myBookings),
  handoff_to_human: define(
    "Pasa la conversación a una persona de la clínica cuando la persona lo pide o no puedes ayudar.",
    NoArgs,
    handoffToHuman,
  ),
};

export type ToolName = keyof typeof TOOLS;

const TERMINAL_STATUSES = new Set(["booked", "rescheduled", "cancelled", "slot_taken", "handoff"]);

export function isTerminal(outcome: ToolOutcome | TerminalOutcome): outcome is TerminalOutcome {
  return TERMINAL_STATUSES.has(outcome.status);
}

const CORRECTABLE_STATUSES = new Set(["unknown_service", "unknown_professional", "invalid_arguments"]);

/** A mistyped name or argument may be retried in the same turn. Any other write attempt uses the turn's one try. */
export function usesWriteAttempt(outcome: ToolOutcome | TerminalOutcome): boolean {
  return !CORRECTABLE_STATUSES.has(outcome.status);
}
