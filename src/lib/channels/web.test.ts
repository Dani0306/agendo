import { describe, expect, it } from "vitest";
import { ChatRequestSchema, webInbound } from "./web";

const ID = "6f1c8f0e-6a3b-4f5e-9a55-2f4a6f0b1c11";

describe("ChatRequestSchema", () => {
  it("trims the text", () => {
    expect(ChatRequestSchema.parse({ messageId: ID, text: "  hola " }).text).toBe("hola");
  });

  it.each([
    [{ messageId: "1", text: "hola" }],
    [{ messageId: ID, text: "   " }],
    [{ messageId: ID, text: "x".repeat(1001) }],
    [{ messageId: ID }],
  ])("refuses %j", (body) => {
    expect(ChatRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe("webInbound", () => {
  it("produces a web message with a namespaced provider id", () => {
    expect(webInbound("visitor", { messageId: ID, text: "hola" }, "whatsapp:+1")).toEqual({
      channel: "web",
      providerMessageId: `web:${ID}`,
      from: "visitor",
      to: "whatsapp:+1",
      body: "hola",
    });
  });
});
