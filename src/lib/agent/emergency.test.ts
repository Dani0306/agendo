import { describe, expect, it } from "vitest";
import { isPossibleEmergency } from "./emergency";

describe("isPossibleEmergency", () => {
  it.each([
    "Tengo un DOLOR EN EL PECHO",
    "no puedo respirar bien",
    "mi mamá se desmayó",
    "creo que es un infarto",
    "me quiero morir",
    "tengo una convulsión",
    "I have chest pain",
    "I can’t breathe",
  ])("flags %s", (text) => {
    expect(isPossibleEmergency(text)).toBe(true);
  });

  it.each([
    "necesito una cita urgente",
    "quiero agendar para el martes",
    "¿cuánto cuesta la valoración?",
    "me duele la rodilla",
    "I'd like an appointment",
  ])("does not flag %s", (text) => {
    expect(isPossibleEmergency(text)).toBe(false);
  });
});
