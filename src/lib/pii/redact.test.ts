import { describe, expect, it } from "vitest";
import { redactPhones } from "./redact";

describe("redactPhones", () => {
  it.each([
    "whatsapp:+573000000001",
    "+573000000001",
    "573000000001",
    "300 000 0001",
    "300-000-0001",
    "(300) 000 0001",
    "+57 300 000 0001",
  ])("removes %s", (phone) => {
    expect(redactPhones(`failed sending to ${phone} today`)).toBe("failed sending to [phone] today");
  });

  it("leaves ordinary text and short numbers alone", () => {
    const text = "HTTP 429 after 3 attempts at 10:30";
    expect(redactPhones(text)).toBe(text);
  });
});
