// Pure helpers for the send-reminders Edge Function. No Deno or Node globals beyond
// Web APIs, so Vitest can test them against the Node code that wrote the data.

const FORMAT = "v1";

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * Reads a phone stored by src/lib/pii/phone.ts (`v1:iv:tag:ciphertext`, AES-256-GCM).
 * WebCrypto expects the tag appended to the ciphertext.
 */
export async function decryptPhone(stored: string, keyBase64: string): Promise<string> {
  const [format, iv, tag, ciphertext] = stored.split(":");
  if (format !== FORMAT || !iv || !tag || !ciphertext) throw new Error("Unknown phone format");

  const key = await crypto.subtle.importKey("raw", fromBase64(keyBase64), "AES-GCM", false, ["decrypt"]);
  const body = fromBase64(ciphertext);
  const authTag = fromBase64(tag);
  const sealed = new Uint8Array(new ArrayBuffer(body.length + authTag.length));
  sealed.set(body);
  sealed.set(authTag, body.length);

  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(iv) }, key, sealed);
  return new TextDecoder().decode(plain);
}

/** Constant-time for equal lengths; a length mismatch returns early, which leaks only the length. */
export function safeEqual(received: string, expected: string): boolean {
  const a = new TextEncoder().encode(received);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index]! ^ b[index]!;
  return difference === 0;
}

/**
 * The template's two placeholders: day and time, in the tenant's zone. Nothing names
 * the service, because a WhatsApp preview shows on a lock screen. The variable layout
 * of Twilio's built-in template is VERIFY (the trial can't read it from the Content API).
 */
export function reminderVariables(startsAt: Date, timezone: string): Record<"1" | "2", string> {
  const day = new Intl.DateTimeFormat("es-CO", { timeZone: timezone, weekday: "short", day: "numeric", month: "short" });
  const time = new Intl.DateTimeFormat("es-CO", { timeZone: timezone, hour: "numeric", minute: "2-digit", hour12: true });
  return { "1": day.format(startsAt).replace(/ /g, " "), "2": time.format(startsAt).replace(/ /g, " ") };
}

export function templateForm(message: {
  to: string;
  from: string;
  contentSid: string;
  variables: Record<string, string>;
}): URLSearchParams {
  return new URLSearchParams({
    To: message.to.startsWith("whatsapp:") ? message.to : `whatsapp:${message.to}`,
    From: message.from,
    ContentSid: message.contentSid,
    ContentVariables: JSON.stringify(message.variables),
  });
}

/** What goes into reminders.error: Twilio's numeric code, never the message text, which can quote the number. */
export function providerErrorCode(status: number, body: unknown): string {
  const code = typeof body === "object" && body !== null && "code" in body ? (body as { code: unknown }).code : undefined;
  return typeof code === "number" ? `twilio_${code}` : `http_${status}`;
}
