/** Calendar date and wall-clock time in a tenant's zone. */
export type LocalParts = { date: string; time: string };

export type LocalToUtc =
  | { ok: true; at: Date }
  | { ok: false; reason: "invalid" | "nonexistent" | "ambiguous" };

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_MS = 86_400_000;

function formatter(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function wallClockMs(instant: Date, format: Intl.DateTimeFormat): number {
  const part: Record<string, number> = {};
  for (const { type, value } of format.formatToParts(instant)) part[type] = Number(value);
  return Date.UTC(part.year!, part.month! - 1, part.day!, part.hour!, part.minute!, part.second!);
}

export function utcToLocal(instant: Date, timezone: string): LocalParts {
  const wall = new Date(wallClockMs(instant, formatter(timezone))).toISOString();
  return { date: wall.slice(0, 10), time: wall.slice(11, 16) };
}

/**
 * Converts a wall-clock time to an instant. A time skipped by a DST change has no
 * instant, and a time repeated by one has two, so both are refused rather than guessed.
 */
export function localToUtc({ date, time }: LocalParts, timezone: string): LocalToUtc {
  const dateMatch = DATE_PATTERN.exec(date);
  const timeMatch = TIME_PATTERN.exec(time);
  if (!dateMatch || !timeMatch) return { ok: false, reason: "invalid" };

  const [year, month, day] = [Number(dateMatch[1]), Number(dateMatch[2]), Number(dateMatch[3])];
  const wall = Date.UTC(year, month - 1, day, Number(timeMatch[1]), Number(timeMatch[2]));
  const calendar = new Date(wall);
  if (calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return { ok: false, reason: "invalid" };

  // The offsets a day either side cover both sides of any DST change near this time.
  const format = formatter(timezone);
  const offsets = [wall - DAY_MS, wall + DAY_MS].map((probe) => wallClockMs(new Date(probe), format) - probe);
  const matches = [...new Set(offsets.map((offset) => wall - offset))].filter(
    (candidate) => wallClockMs(new Date(candidate), format) === wall,
  );

  if (matches.length === 0) return { ok: false, reason: "nonexistent" };
  if (matches.length > 1) return { ok: false, reason: "ambiguous" };
  return { ok: true, at: new Date(matches[0]!) };
}

/** ISO weekday of a calendar date: 1 is Monday, 7 is Sunday. */
export function isoWeekday(date: string): number {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** For customers: "martes 10 de noviembre de 2026". */
export function spanishDate(date: string): string {
  return new Intl.DateTimeFormat("es-CO", { timeZone: "UTC", dateStyle: "full" })
    .format(new Date(`${date}T12:00:00Z`))
    .replace(",", "");
}

/** For customers: "3:00 p. m.". */
export function spanishTime(time: string): string {
  return new Intl.DateTimeFormat("es-CO", { timeZone: "UTC", hour: "numeric", minute: "2-digit", hour12: true })
    .format(new Date(`2000-01-01T${time}:00Z`))
    .replace(/ /g, " ");
}
