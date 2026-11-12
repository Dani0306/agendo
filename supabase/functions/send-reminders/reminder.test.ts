import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encryptPhone } from "@/lib/pii/phone";
import { decryptPhone, providerErrorCode, reminderVariables, safeEqual, templateForm } from "./reminder";

describe("decryptPhone", () => {
  it("reads a phone the Node code encrypted", async () => {
    const key = randomBytes(32);
    const stored = encryptPhone("whatsapp:+573000000001", key);
    expect(await decryptPhone(stored, key.toString("base64"))).toBe("+573000000001");
  });

  it("refuses the wrong key", async () => {
    const stored = encryptPhone("+573000000001", randomBytes(32));
    await expect(decryptPhone(stored, randomBytes(32).toString("base64"))).rejects.toThrow();
  });

  it("refuses an unknown format", async () => {
    await expect(decryptPhone("v2:a:b:c", randomBytes(32).toString("base64"))).rejects.toThrow("Unknown phone format");
  });
});

describe("safeEqual", () => {
  it("compares tokens", () => {
    expect(safeEqual("abc123", "abc123")).toBe(true);
    expect(safeEqual("abc124", "abc123")).toBe(false);
    expect(safeEqual("abc", "abc123")).toBe(false);
    expect(safeEqual("", "abc123")).toBe(false);
  });
});

describe("reminderVariables", () => {
  it("gives the day and time in the tenant's zone", () => {
    // 20:00 UTC is 3:00 p. m. in Bogota.
    expect(reminderVariables(new Date("2026-11-10T20:00:00Z"), "America/Bogota")).toEqual({
      "1": "mar, 10 de nov",
      "2": "3:00 p. m.",
    });
  });

  it("uses the local date when it differs from the UTC date", () => {
    expect(reminderVariables(new Date("2026-11-11T02:00:00Z"), "America/Bogota")["1"]).toBe("mar, 10 de nov");
  });
});

describe("templateForm", () => {
  it("sends the template and its variables, and no free text", () => {
    const form = templateForm({ to: "+573000000001", from: "whatsapp:+14155238886", contentSid: "HX1", variables: { "1": "a", "2": "b" } });
    expect(form.get("To")).toBe("whatsapp:+573000000001");
    expect(form.get("ContentSid")).toBe("HX1");
    expect(JSON.parse(form.get("ContentVariables")!)).toEqual({ "1": "a", "2": "b" });
    expect(form.has("Body")).toBe(false);
  });
});

describe("providerErrorCode", () => {
  it("keeps Twilio's code and drops its message", () => {
    expect(providerErrorCode(400, { code: 21656, message: "bad variables for whatsapp:+573000000001" })).toBe("twilio_21656");
    expect(providerErrorCode(502, "gateway")).toBe("http_502");
  });
});
