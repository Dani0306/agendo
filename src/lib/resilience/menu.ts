import { formatMoney, type PromptTenant } from "@/lib/agent/prompt";
import type { Reply } from "@/lib/agent/reply";

/**
 * The degradation chain's static step: a numbered menu answered from the tenant's own
 * rows, with no model. Numbered text, not buttons, because WhatsApp buttons need an
 * approved template and the sandbox may not render them.
 */
export const MENU_TEXT = [
  "En este momento no puedo responder mensajes escritos. Responde con un número:",
  "1. Servicios y precios\n2. Horario\n3. Preguntas frecuentes\n4. Hablar con una persona",
  "Para agendar, cambiar o cancelar una cita, elige 4 o escríbenos de nuevo más tarde.",
].join("\n\n");

const AGAIN = "Responde otro número para ver más, o escribe tu mensaje.";

export type MenuChoice = 1 | 2 | 3 | 4;

export const MENU_SHOWN = { name: "menu", status: "shown" } as const;

/** "2", " 2 ", "2." and "2)" all count. Anything else is a normal message. */
export function parseMenuChoice(text: string): MenuChoice | null {
  const match = /^\s*([1-4])\s*[.)]?\s*$/.exec(text);
  return match ? (Number(match[1]) as MenuChoice) : null;
}

export function wasMenuShown(tools: { name: string; status: string }[]): boolean {
  return tools.some((tool) => tool.name === MENU_SHOWN.name && tool.status === MENU_SHOWN.status);
}

export function menuReply(degraded: NonNullable<Reply["degraded"]>): Reply {
  return { text: MENU_TEXT, degraded, trace: { model: null, tools: [MENU_SHOWN] } };
}

/** Choices 1 to 3. Choice 4 is a handoff, which the caller performs. */
export function menuAnswerText(choice: Exclude<MenuChoice, 4>, tenant: PromptTenant): string {
  const body = (() => {
    switch (choice) {
      case 1:
        return `Servicios y precios:\n${tenant.services
          .map((service) => `- ${service.name}: ${service.duration_minutes} minutos, ${formatMoney(service.price, tenant.currency)}`)
          .join("\n")}`;
      case 2:
        return `Horario:\n${tenant.hours.map((line) => `- ${line}`).join("\n")}`;
      case 3:
        return `Preguntas frecuentes:\n\n${tenant.faq.map((item) => `${item.question}\n${item.answer}`).join("\n\n")}`;
    }
  })();
  return `${body}\n\n${AGAIN}`;
}

export function menuAnswerReply(choice: Exclude<MenuChoice, 4>, tenant: PromptTenant): Reply {
  return { text: menuAnswerText(choice, tenant), degraded: "menu", trace: { model: null, tools: [MENU_SHOWN] } };
}
