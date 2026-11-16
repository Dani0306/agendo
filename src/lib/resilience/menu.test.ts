import { describe, expect, it } from "vitest";
import type { PromptTenant } from "@/lib/agent/prompt";
import { MENU_TEXT, menuAnswerReply, menuAnswerText, menuReply, parseMenuChoice, wasMenuShown } from "./menu";

const tenant: PromptTenant = {
  name: "Clínica",
  timezone: "America/Bogota",
  currency: "COP",
  services: [{ name: "Valoración inicial", duration_minutes: 60, price: 90000 }],
  hours: ["lunes: 7:00 a. m. a 6:00 p. m.", "domingo: cerrado"],
  faq: [{ question: "¿Dónde están?", answer: "Calle Ficticia 12." }],
};

describe("parseMenuChoice", () => {
  it.each([
    ["1", 1],
    [" 2 ", 2],
    ["3.", 3],
    ["4)", 4],
  ])("reads %j as %s", (text, choice) => {
    expect(parseMenuChoice(text)).toBe(choice);
  });

  it.each(["0", "5", "12", "opción 2", "2 por favor", ""])("ignores %j", (text) => {
    expect(parseMenuChoice(text)).toBeNull();
  });
});

describe("menu answers", () => {
  it("lists services with prices from the tenant's rows", () => {
    // es-CO puts a no-break space after the sign.
    expect(menuAnswerText(1, tenant)).toContain("Valoración inicial: 60 minutos, $\u00a090.000");
  });

  it("lists the hours", () => {
    expect(menuAnswerText(2, tenant)).toContain("domingo: cerrado");
  });

  it("lists the FAQ", () => {
    expect(menuAnswerText(3, tenant)).toContain("¿Dónde están?\nCalle Ficticia 12.");
  });

  it("marks every menu reply so the next number is read as a choice", () => {
    expect(wasMenuShown(menuReply("menu").trace.tools)).toBe(true);
    expect(wasMenuShown(menuAnswerReply(1, tenant).trace.tools)).toBe(true);
    expect(wasMenuShown([{ name: "my_bookings", status: "ok" }])).toBe(false);
  });

  it("offers a person and says booking needs one", () => {
    expect(MENU_TEXT).toContain("4. Hablar con una persona");
    expect(MENU_TEXT).toContain("Para agendar");
  });

  it("answers with no model", () => {
    expect(menuReply("over_budget").trace.model).toBeNull();
  });
});
