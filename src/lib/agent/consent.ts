export const CONSENT_VERSION = "v1-draft";

export type ConsentStatus = "pending" | "granted" | "declined";

export type ConsentDecision = "grant" | "decline" | "request_consent" | "run_agent" | "ask_to_resend" | "ignore";

const ACCEPT_WORD = "ACEPTO";
const DECLINE_WORD = "NO";

/** Case, accents, punctuation and spaces don't count, so "acepto." and "Nó!" still match. */
function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}]/gu, "")
    .toUpperCase();
}

/**
 * What may be stored of a message that arrived before consent. Only the literal
 * answer: anything else could contain health data the person hasn't authorised.
 */
export function storableBeforeConsent(text: string): string | null {
  const word = normalize(text);
  return word === ACCEPT_WORD || word === DECLINE_WORD ? word : null;
}

export function decideConsent(status: ConsentStatus, storedContent: string | null): ConsentDecision {
  if (status === "granted") return storedContent === null ? "ask_to_resend" : "run_agent";
  if (storedContent === ACCEPT_WORD) return "grant";
  if (status === "declined") return "ignore";
  return storedContent === DECLINE_WORD ? "decline" : "request_consent";
}

/** Draft wording. A lawyer must review it before a real clinic uses it. */
export function consentRequestText(clinicName: string, privacyUrl: string): string {
  return [
    `Hola, soy el asistente de citas de ${clinicName}. Para ayudarte por este chat tratamos tu nombre, tu número y los datos de tus citas, con el fin de agendarlas y enviarte recordatorios.`,
    "Como pueden revelar información de salud, son datos sensibles y no estás obligado(a) a autorizar su tratamiento. Se procesan con proveedores en Estados Unidos.",
    "Por favor no envíes síntomas, diagnósticos ni documentos.",
    `Política: ${privacyUrl}`,
    "Responde ACEPTO para continuar o NO para no continuar.",
  ].join("\n\n");
}

export const CONSENT_GRANTED_REPLY = "Gracias por autorizar. ¿En qué te ayudo? Puedo agendar, cambiar o cancelar citas y responder tus preguntas.";

export const CONSENT_DECLINED_REPLY =
  "Entendido. No usaremos tus datos por este chat y borramos tu número. Para agendar, comunícate directamente con la clínica. Si cambias de opinión, escribe ACEPTO.";

export const TEXT_ONLY_REPLY = "Por ahora solo puedo leer mensajes de texto. ¿Me lo escribes, por favor?";

export const RESEND_MESSAGE_REPLY =
  "Tu mensaje llegó antes de tu autorización, así que no lo guardamos. Por favor envíalo de nuevo.";
