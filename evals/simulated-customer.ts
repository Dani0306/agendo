// The simulated customer: a model call that plays one persona with one goal, sees the
// conversation so far, and writes the next WhatsApp message or [FIN].
import { generateText, type LanguageModel, type ModelMessage } from "ai";
import { recordCall, type RecordCallDeps } from "@/lib/calls/record-call";
import type { Scenario } from "./schema";
import type { TranscriptTurn } from "./scorer";

export const DONE = "[FIN]";

export function customerInstructions(scenario: Scenario, now: string): string {
  return [
    "Eres una persona que escribe por WhatsApp a una clínica de fisioterapia. No eres un asistente: eres el cliente.",
    `Quién eres y cómo escribes: ${scenario.persona}`,
    `Lo que quieres conseguir: ${scenario.goal}`,
    `Fecha y hora de hoy: ${now}.`,
    "Reglas:",
    "- Escribe un solo mensaje corto y natural, como en WhatsApp. Nada de explicaciones ni de comillas.",
    "- Responde a lo que la clínica te acaba de decir. No inventes información sobre la clínica.",
    "- Si te muestran un menú con números y una opción te sirve, responde solo con el número.",
    `- Cuando consigas tu objetivo, cuando la clínica te dé una respuesta final o cuando ya no tenga sentido seguir, responde exactamente ${DONE}.`,
  ].join("\n");
}

/** The clinic's replies are what the simulated customer hears; its own messages are its turns. */
export function customerView(transcript: TranscriptTurn[]): ModelMessage[] {
  return transcript.map((turn): ModelMessage => (turn.role === "agent" ? { role: "user", content: turn.text } : { role: "assistant", content: turn.text }));
}

export async function nextCustomerMessage(
  deps: { model: LanguageModel; modelId: string; record: RecordCallDeps; tenantId: string; conversationId: string | null },
  scenario: Scenario,
  transcript: TranscriptTurn[],
  now: string,
): Promise<string> {
  const result = await recordCall(
    { tenantId: deps.tenantId, conversationId: deps.conversationId, purpose: "eval_customer", model: deps.modelId },
    deps.record,
    () =>
      generateText({
        model: deps.model,
        instructions: customerInstructions(scenario, now),
        messages: customerView(transcript),
        maxOutputTokens: 200,
        maxRetries: 2,
        providerOptions: { openai: { store: false, reasoningEffort: "low", textVerbosity: "low" } },
      }),
  );
  const text = result.text.trim();
  return text.includes(DONE) || text.length === 0 ? DONE : text;
}
