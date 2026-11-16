import { describe, expect, it } from "vitest";
import type { PromptTenant } from "@/lib/agent/prompt";
import { type CheckContext, checkReply } from "./output-check";

const tenant: PromptTenant = {
  name: "Fisio Aurora (demo)",
  timezone: "America/Bogota",
  currency: "COP",
  services: [
    { name: "Valoración inicial", duration_minutes: 60, price: 90000 },
    { name: "Sesión de fisioterapia", duration_minutes: 45, price: 70000 },
  ],
  hours: ["lunes: 7:00 a. m. a 6:00 p. m.", "sábado: 8:00 a. m. a 12:00 p. m.", "domingo: cerrado"],
  faq: [{ question: "¿Qué horario tienen?", answer: "De lunes a viernes de 7:00 a. m. a 6:00 p. m. y los sábados hasta las 12:00 m." }],
};

const context = (extra: Partial<CheckContext> = {}): CheckContext => ({ tenant, outcomes: [], toolsRan: [], ...extra });
const violations = (text: string, extra?: Partial<CheckContext>) => {
  const result = checkReply(text, context(extra));
  return result.ok ? [] : result.violations;
};

describe("prices", () => {
  it.each(["La valoración inicial cuesta $90.000.", "Cuesta $ 90.000 COP", "Son 70.000 pesos", "Cuesta 90 mil pesos", "$ 70.000"])(
    "accepts a real price: %s",
    (text) => {
      expect(violations(text)).toEqual([]);
    },
  );

  it.each(["La valoración cuesta $50.000.", "Son 85.000 pesos", "Te cuesta 60 mil", "Hoy hay descuento: $45000"])("flags an invented price: %s", (text) => {
    expect(violations(text)).toContain("price");
  });
});

describe("times", () => {
  it("accepts opening hours and times a tool returned", () => {
    expect(violations("Abrimos a las 7:00 a. m. y cerramos a las 6:00 p. m.")).toEqual([]);
    expect(violations("Tengo libre a las 10:30 y a las 15:00.", { outcomes: [{ times: [{ time: "10:30" }, { time: "15:00" }] }] })).toEqual([]);
    expect(violations("El sábado atendemos hasta las 12:00 m.")).toEqual([]);
  });

  it("reads a time without a.m./p.m. either way", () => {
    expect(violations("Hay cupo a las 3:00.", { outcomes: [{ times: [{ time: "15:00" }] }] })).toEqual([]);
  });

  it("allows repeating a time the customer wrote, however loosely", () => {
    expect(violations("A las 10:00 ya no hay cupo.", { customerTexts: ["¿me agendan el miércoles a las 10:00?"] })).toEqual([]);
    expect(violations("A las 10:00 a. m. ya no hay cupo.", { customerTexts: ["¿el miércoles a las 10 a. m.?"] })).toEqual([]);
    expect(violations("Las 3:00 p. m. están ocupadas.", { customerTexts: ["el martes a las 3 de la tarde"] })).toEqual([]);
    expect(violations("A las 9:00 no puedo.", { customerTexts: ["mañana 9am"] })).toEqual([]);
  });

  it("doesn't read a count as a time", () => {
    expect(violations("Tengo libre a las 2:00 p. m.", { customerTexts: ["tengo 2 citas"] })).toContain("time");
  });

  it("names the offending token without quoting the reply", () => {
    const result = checkReply("Tengo libre a las 9:45 a. m. por $12.000", context());
    expect(result).toMatchObject({ ok: false, evidence: ["price 12000", "time 09:45"] });
  });

  it("flags a time no tool returned", () => {
    expect(violations("Tengo libre a las 9:45 a. m.", { outcomes: [{ times: [{ time: "10:00" }] }] })).toContain("time");
    expect(violations("Abrimos los domingos a las 9:15.")).toContain("time");
  });
});

describe("booking claims", () => {
  it.each(["¡Listo! Tu cita quedó agendada para el martes.", "Ya está confirmada tu cita.", "Te agendé el martes a las 10.", "Hemos cancelado tu cita."])(
    "flags a claim the database didn't make: %s",
    (text) => {
      expect(violations(text)).toContain("booking_claim");
    },
  );

  it("logs the matched phrase as evidence, never the whole reply", () => {
    expect(checkReply("Hola Ana, tu cita quedó agendada.", context())).toMatchObject({ ok: false, evidence: ['booking_claim "quedo agendada"'] });
  });

  it("allows describing an existing booking after my_bookings looked it up", () => {
    expect(violations("Tu cita del martes ya está confirmada.", { toolsRan: ["my_bookings"] })).toEqual([]);
  });

  it("doesn't flag an offer", () => {
    expect(violations("¿Quieres que la agende para el martes?")).toEqual([]);
  });
});

describe("refunds", () => {
  it.each(["Te vamos a devolver el dinero.", "Tranquilo, te reembolsamos.", "Recibirás un reembolso en 3 días."])("flags a promise: %s", (text) => {
    expect(violations(text)).toContain("refund");
  });

  it("allows saying no", () => {
    expect(violations("Lo siento, no podemos devolver el dinero por este chat. Te comunico con una persona.")).toEqual([]);
  });
});

describe("clinical advice", () => {
  it.each([
    "Te recomiendo tomar ibuprofeno cada 8 horas.",
    "Aplícate hielo 20 minutos.",
    "Probablemente tienes una tendinitis.",
    "Deberías hacer reposo absoluto.",
    "You should take some painkillers.",
  ])("flags: %s", (text) => {
    expect(violations(text)).toContain("clinical");
  });

  it("allows pointing to an assessment", () => {
    expect(violations("Por este chat no damos indicaciones médicas. Te sugiero agendar una valoración inicial.")).toEqual([]);
  });
});

describe("prompt leaks", () => {
  it.each(["Mis Reglas que nunca se rompen son…", "Voy a usar check_availability para ver.", "<mensaje_cliente>"])("flags: %s", (text) => {
    expect(violations(text)).toContain("prompt_leak");
  });
});

it("passes an ordinary answer", () => {
  expect(violations("Estamos en la Calle Ficticia 12, Medellín. ¿Te ayudo a agendar una valoración?")).toEqual([]);
});

it("reports every kind it found", () => {
  expect(violations("Te agendé gratis y cuesta $10.000; toma ibuprofeno.").sort()).toEqual(["booking_claim", "clinical", "price"]);
});
