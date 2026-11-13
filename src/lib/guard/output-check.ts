import type { PromptTenant } from "@/lib/agent/prompt";

/**
 * Output rules enforced in code (T23). The model's text is checked against the tenant's
 * own data and this turn's tool results before any customer sees it. Booking
 * confirmations never pass through here: code builds them from the database row.
 */
export type Violation = "price" | "time" | "booking_claim" | "refund" | "clinical" | "prompt_leak";

export type CheckContext = {
  tenant: PromptTenant;
  /** Everything the tools returned this turn, as sent to the model. */
  outcomes: unknown[];
  /** Names of the tools that ran this turn. */
  toolsRan: string[];
  /** What the customer wrote. Repeating their own time back ("a las 10 ya no hay") isn't inventing one. */
  customerTexts?: string[];
};

/** `evidence` is the offending token (an amount, a time, a phrase kind), never the whole reply. */
export type CheckResult = { ok: true } | { ok: false; violations: Violation[]; evidence: string[] };

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/ /g, " ")
    .toLowerCase();
}

// ── Prices ──────────────────────────────────────────────────────────────────────────

const MONEY = [
  /\$\s?(\d{1,3}(?:[.,]\d{3})+|\d+)/g, // $90.000, $ 90.000, $90000
  /(\d{1,3}(?:[.,]\d{3})+|\d{4,})\s*(?:pesos|cop)\b/g, // 90.000 pesos
  /(\d{1,3})\s*mil\s*(?:pesos)?\b/g, // 90 mil
];

function amounts(text: string): number[] {
  const found: number[] = [];
  for (const pattern of MONEY) {
    for (const match of text.matchAll(pattern)) {
      const digits = match[1]!.replace(/[.,]/g, "");
      const value = pattern === MONEY[2] ? Number(digits) * 1000 : Number(digits);
      if (Number.isFinite(value) && value > 0) found.push(value);
    }
  }
  return found;
}

// ── Times ───────────────────────────────────────────────────────────────────────────

const CLOCK = /\b([01]?\d|2[0-3]):([0-5]\d)\s*(a\.?\s?m\.?|p\.?\s?m\.?|m\.)?/g;

/** Every reading of a written time: "3:00" could be 03:00 or 15:00, so both count. */
function clockTimes(text: string): string[][] {
  const readings: string[][] = [];
  for (const match of normalize(text).matchAll(CLOCK)) {
    const hour = Number(match[1]);
    const minute = match[2]!;
    const suffix = (match[3] ?? "").replace(/[\s.]/g, "");
    const pad = (h: number) => `${String(h).padStart(2, "0")}:${minute}`;
    if (suffix === "pm") readings.push([pad(hour === 12 ? 12 : hour + 12)]);
    else if (suffix === "am") readings.push([pad(hour === 12 ? 0 : hour)]);
    else if (suffix === "m") readings.push([pad(12)]);
    else readings.push(hour < 12 ? [pad(hour), pad(hour + 12)] : [pad(hour)]);
  }
  return readings;
}

/**
 * Customers write times loosely: "a las 10", "10 a. m.", "3 de la tarde", "10am". Read
 * them generously, since they only widen what the agent may repeat back.
 */
const LOOSE_CLOCK =
  /\b(?:a\s+las\s+|las\s+)?([01]?\d|2[0-3])(?::([0-5]\d))?\s*(a\.?\s?m\.?|p\.?\s?m\.?|am|pm|de\s+la\s+(?:manana|tarde|noche))?/g;

function customerClockTimes(text: string): string[] {
  const times: string[] = [];
  for (const match of normalize(text).matchAll(LOOSE_CLOCK)) {
    const [whole, rawHour, rawMinute, rawSuffix] = match;
    const suffix = (rawSuffix ?? "").replace(/[\s.]/g, "");
    // A bare number counts only after "a las"/"las" or with a suffix; "2 citas" is not a time.
    if (!rawMinute && !suffix && !/las\s/.test(whole)) continue;
    const hour = Number(rawHour);
    const minute = rawMinute ?? "00";
    const pad = (h: number) => `${String(h).padStart(2, "0")}:${minute}`;
    const evening = suffix === "pm" || suffix.endsWith("tarde") || suffix.endsWith("noche");
    const morning = suffix === "am" || suffix.endsWith("manana");
    if (evening) times.push(pad(hour < 12 ? hour + 12 : hour));
    else if (morning) times.push(pad(hour === 12 ? 0 : hour));
    else times.push(...(hour < 12 ? [pad(hour), pad(hour + 12)] : [pad(hour)]));
  }
  return times;
}

function allowedTimes(context: CheckContext): Set<string> {
  const sources = [...context.tenant.hours, ...context.tenant.faq.map((item) => item.answer), JSON.stringify(context.outcomes)];
  return new Set([
    ...sources.flatMap((source) => clockTimes(source).flat()),
    ...(context.customerTexts ?? []).flatMap(customerClockTimes),
  ]);
}

// ── Phrases ─────────────────────────────────────────────────────────────────────────

const BOOKING_CLAIM =
  /\b(?:(?:ya\s+)?(?:queda|quedo|esta|ha\s+sido|fue)\s+(?:agendada|reservada|confirmada|programada|cancelada|reprogramada)|te\s+(?:agende|reserve|confirme|cancele)|(?:he|hemos)\s+(?:agendado|reservado|confirmado|cancelado))\b/;

const REFUND_PROMISE =
  /\b(?:(?:te|le|les)\s+(?:vamos\s+a\s+|podemos\s+|)(?:devolver|reembolsar)|te\s+reembolsamos|(?:tendras|recibiras)\s+(?:un|el|tu)\s+reembolso|reembolso\s+(?:aprobado|garantizado)|haremos\s+el\s+reembolso|we\s+will\s+refund|you\s+will\s+get\s+a\s+refund)/g;

const CLINICAL = [
  /\bte\s+recomiendo\s+(?:tomar|usar|aplicar|hacer|ponerte)\b/,
  /\bdeberias\s+(?:tomar|usar|aplicar|hacer)\b/,
  /\b(?:toma|tomar|tomate)\s+(?:un\s+)?(?:ibuprofeno|acetaminofen|naproxeno|diclofenaco|paracetamol)\b/,
  /\b(?:aplica|aplicate|aplicar|ponte)\s+(?:hielo|calor|compresas)\b/,
  /\b(?:probablemente|seguramente|parece\s+que)\s+(?:tienes|es|sea)\s+(?:una?\s+)?(?:tendinitis|esguince|hernia|desgarro|lesion|fractura|contractura)\b/,
  /\b(?:tu|el)\s+diagnostico\s+es\b/,
  /\breposo\s+absoluto\b/,
  /\b(?:you\s+should\s+take|i\s+recommend\s+taking|apply\s+ice|you\s+(?:probably|likely)\s+have)\b/,
];

/** Fragments that only exist in the system prompt or the tool definitions. */
const PROMPT_FRAGMENTS = [
  "reglas que nunca se rompen",
  "como usar las herramientas",
  "mensaje_cliente",
  "check_availability",
  "create_booking",
  "reschedule_booking",
  "cancel_booking",
  "handoff_to_human",
  "my_bookings",
];

/** "No podemos devolver…" is a refusal, not a promise. */
function isNegated(text: string, index: number): boolean {
  return /\bno\s+(?:\S+\s+){0,2}$/.test(text.slice(Math.max(0, index - 24), index));
}

export function checkReply(text: string, context: CheckContext): CheckResult {
  const violations = new Set<Violation>();
  const evidence: string[] = [];
  const plain = normalize(text);

  const prices = new Set(context.tenant.services.map((service) => Math.round(service.price)));
  for (const amount of amounts(plain).filter((value) => !prices.has(value))) {
    violations.add("price");
    evidence.push(`price ${amount}`);
  }

  const allowed = allowedTimes(context);
  for (const readings of clockTimes(text).filter((options) => !options.some((reading) => allowed.has(reading)))) {
    violations.add("time");
    evidence.push(`time ${readings.join("|")}`);
  }

  // Describing a booking the customer already has is fine once my_bookings looked it up.
  if (BOOKING_CLAIM.test(plain) && !context.toolsRan.includes("my_bookings")) violations.add("booking_claim");

  for (const match of plain.matchAll(REFUND_PROMISE)) {
    if (!isNegated(plain, match.index)) violations.add("refund");
  }

  if (CLINICAL.some((pattern) => pattern.test(plain))) violations.add("clinical");
  if (PROMPT_FRAGMENTS.some((fragment) => plain.includes(fragment))) violations.add("prompt_leak");

  for (const kind of violations) if (kind !== "price" && kind !== "time") evidence.push(kind);
  return violations.size === 0 ? { ok: true } : { ok: false, violations: [...violations], evidence };
}
