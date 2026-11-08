import { describe, expect, it } from "vitest";
import { consentRequestText, decideConsent, storableBeforeConsent } from "./consent";

describe("storableBeforeConsent", () => {
  it.each([
    ["ACEPTO", "ACEPTO"],
    ["acepto", "ACEPTO"],
    ["  Acepto. ", "ACEPTO"],
    ["ACEPTÓ", "ACEPTO"],
    ["No", "NO"],
    ["nó!", "NO"],
  ])("keeps the answer %s", (text, stored) => {
    expect(storableBeforeConsent(text)).toBe(stored);
  });

  it.each(["sí", "si acepto", "no quiero", "me duele la espalda", "", "👍"])("discards %s", (text) => {
    expect(storableBeforeConsent(text)).toBeNull();
  });
});

describe("decideConsent", () => {
  it.each([
    ["pending", null, "request_consent"],
    ["pending", "ACEPTO", "grant"],
    ["pending", "NO", "decline"],
    ["declined", "ACEPTO", "grant"],
    ["declined", "NO", "ignore"],
    ["declined", null, "ignore"],
    ["granted", "quiero una cita", "acknowledge"],
    ["granted", "", "acknowledge"],
    ["granted", null, "ask_to_resend"],
  ] as const)("%s with %s gives %s", (status, content, decision) => {
    expect(decideConsent(status, content)).toBe(decision);
  });
});

describe("consentRequestText", () => {
  it("says the data is sensitive, that authorising is optional, and how to answer", () => {
    const text = consentRequestText("Fisio Aurora (demo)", "https://example.test/privacidad");
    expect(text).toContain("Fisio Aurora (demo)");
    expect(text).toContain("datos sensibles");
    expect(text).toContain("no estás obligado(a)");
    expect(text).toContain("https://example.test/privacidad");
    expect(text).toContain("ACEPTO");
  });
});
