const PHONE_LIKE = /(?:whatsapp:)?\+?\(?\d(?:[\s().-]{0,2}\d){6,14}/g;

/**
 * Replaces anything shaped like a phone number. Used on text bound for logs and
 * model_calls.error. It also catches some long ids and dates, which is the safe
 * direction to be wrong in for a log line.
 */
export function redactPhones(text: string): string {
  return text.replace(PHONE_LIKE, "[phone]");
}
