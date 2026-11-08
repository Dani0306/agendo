import { z } from "zod";

const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const WEEKDAY_NUMBERS = {
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 7,
} as const;

const Weekday = z.enum(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]);

export const TenantSeedSchema = z.object({
  _note: z.string().optional(),
  tenant: z.object({
    name: z.string().min(1),
    business_type: z.string().min(1),
    timezone: z.string().refine((zone) => Intl.supportedValuesOf("timeZone").includes(zone) || zone === "UTC", {
      error: "Not an IANA time zone",
    }),
    language: z.enum(["es", "en"]),
    currency: z.string().length(3),
    monthly_budget_usd: z.number().nonnegative().nullable(),
    receiving_number: z.string().regex(/^whatsapp:\+\d{8,15}$/),
  }),
  services: z
    .array(
      z.object({
        name: z.string().min(1),
        duration_minutes: z.number().int().positive(),
        price: z.number().nonnegative(),
      }),
    )
    .min(1),
  resources: z.array(z.object({ name: z.string().min(1), kind: z.string().min(1) })).min(1),
  availability_rules: z.object({
    applies_to: z.literal("all_resources"),
    weekly: z
      .array(z.object({ weekday: Weekday, opens: clockTime, closes: clockTime }))
      .min(1)
      .refine((rows) => rows.every((row) => row.opens < row.closes), { error: "opens must be before closes" }),
    closed_dates: z.array(z.iso.date()),
  }),
  faq: z.array(z.object({ question: z.string().min(1), answer: z.string().min(1) })).min(1),
});

export type TenantSeed = z.infer<typeof TenantSeedSchema>;
