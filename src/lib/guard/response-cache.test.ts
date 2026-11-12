import { describe, expect, it } from "vitest";
import { cacheKey, isCacheableQuestion, normalizeQuestion, tenantVersion } from "./response-cache";

describe("normalizeQuestion", () => {
  it("ignores case, accents, punctuation and spacing", () => {
    expect(normalizeQuestion("¿Dónde   ESTÁN ubicados?")).toBe("donde estan ubicados");
    expect(normalizeQuestion("donde estan ubicados")).toBe(normalizeQuestion("¿Dónde están ubicados?!"));
  });
});

describe("isCacheableQuestion", () => {
  it.each(["¿Dónde están ubicados?", "¿Cuánto cuesta la valoración inicial?", "¿Atienden por EPS o prepagada?"])("caches %s", (text) => {
    expect(isCacheableQuestion(text)).toBe(true);
  });

  it.each([
    "hola",
    "sí gracias",
    "Quiero agendar una valoración",
    "¿Tienen cupo el martes?",
    "Cancela mi cita",
    "¿Puedo cambiar la hora?",
    "¿Qué horarios hay disponibles mañana?",
    "I want to book an appointment",
  ])("never caches %s", (text) => {
    expect(isCacheableQuestion(text)).toBe(false);
  });
});

describe("cacheKey", () => {
  const base = { tenantId: "t1", version: "v", localDate: "2026-11-12", question: "¿Dónde están ubicados?" };

  it("is the same for the same question written differently", () => {
    expect(cacheKey(base)).toBe(cacheKey({ ...base, question: "donde estan ubicados" }));
  });

  it("changes with the tenant, the tenant's data and the date", () => {
    expect(cacheKey({ ...base, tenantId: "t2" })).not.toBe(cacheKey(base));
    expect(cacheKey({ ...base, version: "w" })).not.toBe(cacheKey(base));
    expect(cacheKey({ ...base, localDate: "2026-11-13" })).not.toBe(cacheKey(base));
  });

  it("never contains the question text", () => {
    expect(cacheKey({ ...base, question: "¿tratan la hernia discal?" })).not.toContain("hernia");
  });
});

describe("tenantVersion", () => {
  const tenant = { faq: [{ question: "q", answer: "a" }], services: [{ name: "s", price: 1 }], hours: ["lunes"] };

  it("changes when a price changes", () => {
    expect(tenantVersion({ ...tenant, services: [{ name: "s", price: 2 }] })).not.toBe(tenantVersion(tenant));
  });

  it("is stable for the same data", () => {
    expect(tenantVersion(structuredClone(tenant))).toBe(tenantVersion(tenant));
  });
});
