import { describe, expect, it, vi } from "vitest";
import { computeTwilioSignature, isValidTwilioSignature, sendWhatsApp, WhatsAppInboundSchema } from "./whatsapp";

const URL_SIGNED = "https://example.test/api/whatsapp";
const TOKEN = "test-token";
const PARAMS = { To: "whatsapp:+14155238886", From: "whatsapp:+573000000001", MessageSid: "SM1", Body: "hola" };

// printf '%s' '<url>BodyholaFromwhatsapp:+573000000001MessageSidSM1Towhatsapp:+14155238886' \
//   | openssl dgst -sha1 -hmac 'test-token' -binary | base64
const SIGNATURE_FROM_OPENSSL = "ai//cRvRpOy+/X4z/TnnjQV9IpU=";

describe("Twilio signature", () => {
  it("matches a value computed independently with openssl", () => {
    expect(computeTwilioSignature(URL_SIGNED, PARAMS, TOKEN)).toBe(SIGNATURE_FROM_OPENSSL);
  });

  it("accepts the right signature", () => {
    expect(isValidTwilioSignature(SIGNATURE_FROM_OPENSSL, URL_SIGNED, PARAMS, TOKEN)).toBe(true);
  });

  it.each([
    ["a missing signature", null, URL_SIGNED, PARAMS, TOKEN],
    ["a forged signature", "forged", URL_SIGNED, PARAMS, TOKEN],
    ["another URL", SIGNATURE_FROM_OPENSSL, "https://example.test/other", PARAMS, TOKEN],
    ["a changed body", SIGNATURE_FROM_OPENSSL, URL_SIGNED, { ...PARAMS, Body: "adios" }, TOKEN],
    ["another token", SIGNATURE_FROM_OPENSSL, URL_SIGNED, PARAMS, "other-token"],
  ])("rejects %s", (_name, signature, url, params, token) => {
    expect(isValidTwilioSignature(signature, url, params, token)).toBe(false);
  });
});

describe("WhatsAppInboundSchema", () => {
  it("parses a message and defaults an empty body", () => {
    expect(WhatsAppInboundSchema.parse({ ...PARAMS, Body: undefined }).Body).toBe("");
  });

  it("rejects a number from another channel", () => {
    expect(WhatsAppInboundSchema.safeParse({ ...PARAMS, From: "+573000000001" }).success).toBe(false);
  });
});

describe("sendWhatsApp", () => {
  const credentials = { accountSid: "AC123", authToken: TOKEN, from: "whatsapp:+14155238886" };

  it("posts the form to the account's messages endpoint", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ sid: "SM999", status: "queued" }, { status: 201 }));

    const sid = await sendWhatsApp({ to: "+573000000001", body: "Hola" }, credentials, fetchImpl);

    expect(sid).toBe("SM999");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from(`AC123:${TOKEN}`).toString("base64")}`,
    );
    expect(Object.fromEntries(init.body as URLSearchParams)).toEqual({
      To: "whatsapp:+573000000001",
      From: "whatsapp:+14155238886",
      Body: "Hola",
    });
  });

  it("throws without repeating the phone number", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ code: 63015, message: "not joined: whatsapp:+573000000001" }, { status: 400 }),
    );

    const failure = await sendWhatsApp({ to: "+573000000001", body: "Hola" }, credentials, fetchImpl).catch(
      (error: Error) => error,
    );

    expect(String(failure)).toContain("63015");
    expect(String(failure)).not.toContain("573000000001");
  });
});
