import { z } from "zod";
import { spanishDate, spanishTime } from "@/lib/booking/timezone";

export const BookingEvidenceSchema = z.object({
  service: z.string(),
  professional: z.string(),
  date: z.string(),
  time: z.string(),
  dateText: z.string(),
  timeText: z.string(),
  timezone: z.string(),
  status: z.enum(["confirmed", "cancelled"]),
});

export type BookingEvidence = z.infer<typeof BookingEvidenceSchema>;

export const SlotOptionSchema = z.object({
  date: z.string(),
  time: z.string(),
  dateText: z.string(),
  timeText: z.string(),
  professional: z.string(),
});

export type SlotOption = z.infer<typeof SlotOptionSchema>;

/** What the core produces. Each channel renders it; none of them adds agent logic. */
export const ReplySchema = z.object({
  text: z.string(),
  booking: BookingEvidenceSchema.optional(),
  alternatives: z.array(SlotOptionSchema).optional(),
  degraded: z.enum(["handoff", "person_soon", "rate_limited", "over_budget"]).optional(),
  trace: z.object({
    model: z.string().nullable(),
    tools: z.array(z.object({ name: z.string(), status: z.string() })),
  }),
});

export type Reply = z.infer<typeof ReplySchema>;

export const PERSON_SOON_TEXT = "Tuve un problema para responder. Una persona de la clínica te escribirá pronto.";

export const RATE_LIMITED_TEXT = "Estás enviando mensajes muy rápido. Espera un momento y vuelve a escribir, por favor.";

/** T20 replaces this with the button menu. */
export const OVER_BUDGET_TEXT =
  "En este momento no puedo responder automáticamente. Una persona de la clínica te escribirá pronto.";

export const HANDOFF_TEXT = "Listo, le pasé tu conversación a una persona de la clínica. Te responderá pronto por este chat.";

export const HANDOFF_ACK_TEXT = "Recibimos tu mensaje. Una persona de la clínica te responderá pronto por este chat.";

/** Names no number: only line 123 for Bogotá has been verified so far. */
export const EMERGENCY_TEXT =
  "Lo que describes puede ser una emergencia. Busca atención de urgencias de inmediato o llama a la línea de emergencias de tu ciudad. Este chat solo agenda citas y no puede ayudarte con esto. Ya le avisamos a una persona de la clínica.";

export function staticReply(text: string, degraded?: Reply["degraded"]): Reply {
  return { text, ...(degraded ? { degraded } : {}), trace: { model: null, tools: [] } };
}

export function slotOption(slot: { date: string; time: string; professional: string }): SlotOption {
  return { ...slot, dateText: spanishDate(slot.date), timeText: spanishTime(slot.time) };
}

export function bookingEvidence(
  row: { service: string; professional: string; date: string; time: string; timezone: string },
  status: BookingEvidence["status"],
): BookingEvidence {
  return { ...row, dateText: spanishDate(row.date), timeText: spanishTime(row.time), status };
}

function bookingLines(booking: BookingEvidence): string {
  return [
    `Servicio: ${booking.service}`,
    `Con: ${booking.professional}`,
    `Día: ${booking.dateText}`,
    `Hora: ${booking.timeText} (zona horaria ${booking.timezone})`,
  ].join("\n");
}

export const bookedText = (booking: BookingEvidence) => `Tu cita quedó confirmada.\n\n${bookingLines(booking)}`;

export const rescheduledText = (booking: BookingEvidence) => `Tu cita quedó cambiada.\n\n${bookingLines(booking)}`;

export const cancelledText = (booking: BookingEvidence) => `Tu cita quedó cancelada.\n\n${bookingLines(booking)}`;

export function slotTakenText(alternatives: SlotOption[]): string {
  if (alternatives.length === 0) {
    return "Ese horario acaba de ocuparse y no encontré otros en los próximos días. ¿Quieres que te comunique con una persona de la clínica?";
  }
  const lines = alternatives.map((slot) => `- ${slot.dateText}, ${slot.timeText}, con ${slot.professional}`);
  return `Ese horario acaba de ocuparse. Estas son otras opciones:\n\n${lines.join("\n")}\n\n¿Cuál prefieres?`;
}
