import { z } from "zod";

const LocalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const LocalTime = z.string().regex(/^\d{2}:\d{2}$/);

export const TAGS = [
  "smoke",
  "booking",
  "reschedule",
  "cancel",
  "faq",
  "escalation",
  "injection",
  "health",
  "language",
  "tone",
  "edge",
] as const;

/** A booking that already exists when the scenario starts: the customer's own, or someone else's. */
const SetupBookingSchema = z.object({
  service: z.string().min(1),
  professional: z.string().min(1),
  date: LocalDate,
  time: LocalTime,
  mine: z.boolean().default(false),
});

export const ScenarioSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().min(1),
  tags: z.array(z.enum(TAGS)).default([]),
  /** The moment the conversation happens, with its offset. The agent sees this as "now". */
  clock: z.iso.datetime({ offset: true }),
  /** Who the simulated customer is and how they write. */
  persona: z.string().min(1),
  /** What they want, including what to do if it can't be had. Only the simulated customer sees it. */
  goal: z.string().min(1),
  opening: z.string().min(1),
  max_turns: z.number().int().min(1).max(10).default(8),
  setup: z.object({ bookings: z.array(SetupBookingSchema).default([]) }).default({ bookings: [] }),
  expect: z.object({
    /**
     * booked / rescheduled: the customer ends with a confirmed booking matching `booking`.
     * cancelled: something of theirs was cancelled; `booking`, if given, is what remains.
     * answered: every `mentions` fact appeared, and nothing was booked.
     * escalated: the conversation was handed to a person.
     * no_booking: nothing was booked for them.
     * any: only the safety checks count (used for injection attempts).
     */
    outcome: z.enum(["booked", "rescheduled", "cancelled", "answered", "escalated", "no_booking", "any"]),
    booking: z
      .object({ service: z.string().min(1), date: LocalDate.optional(), time: LocalTime.optional(), professional: z.string().optional() })
      .optional(),
    /** A slot the final booking must not be in (it was taken). */
    avoid: z.object({ date: LocalDate, time: LocalTime }).optional(),
    /** Text that must appear in some reply, compared without accents or case. */
    mentions: z.array(z.string().min(1)).default([]),
    /** Bookings set up for other customers must still be confirmed at the end. */
    others_untouched: z.boolean().default(false),
  }),
});

export type Scenario = z.infer<typeof ScenarioSchema>;
