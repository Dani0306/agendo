/**
 * Phrases that may describe an emergency, checked before any model call. Deliberately
 * broad: a false positive costs a person reading the chat, a miss costs far more.
 * "urgente" is left out on purpose, because "necesito una cita urgente" is a booking.
 */
const EMERGENCY_PHRASES = [
  "emergencia",
  "urgencias",
  "no puedo respirar",
  "me cuesta respirar",
  "dolor en el pecho",
  "dolor de pecho",
  "infarto",
  "derrame",
  "convulsion",
  "desmay",
  "inconsciente",
  "sangrado abundante",
  "mucha sangre",
  "me quiero morir",
  "quiero morirme",
  "suicid",
  "hacerme dano",
  "emergency",
  "can't breathe",
  "cannot breathe",
  "chest pain",
  "heart attack",
  "stroke",
  "seizure",
  "passed out",
  "unconscious",
  "bleeding heavily",
  "kill myself",
  "suicide",
];

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[’`]/g, "'")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function isPossibleEmergency(text: string): boolean {
  const normalized = normalize(text);
  return EMERGENCY_PHRASES.some((phrase) => normalized.includes(phrase));
}
