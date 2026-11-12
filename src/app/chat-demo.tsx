"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import type { Reply } from "@/lib/agent/reply";
import { ChatResponseSchema } from "@/lib/channels/web";

type Bubble =
  | { id: string; from: "customer"; text: string }
  | { id: string; from: "clinic"; reply: Reply }
  | { id: string; from: "notice"; text: string };

const SAMPLES = [
  "Hola",
  "ACEPTO",
  "¿Cuánto cuesta la valoración inicial?",
  "Quiero una valoración inicial el próximo martes a las 10 de la mañana",
  "Cambia mi cita para ese día a las 3 de la tarde",
  "Cancela mi cita",
  "Quiero hablar con una persona",
];

const UNAVAILABLE = "No pudimos conectar con el asistente. Intenta de nuevo en un momento.";

const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800";

function Evidence({ reply }: { reply: Reply }) {
  const { booking, alternatives } = reply;
  return (
    <>
      {booking && (
        <dl data-testid="booking-evidence" className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 rounded-md border border-stone-300 bg-stone-50 p-2 text-xs">
          <dt className="font-semibold">Estado en la base de datos</dt>
          <dd>{booking.status === "confirmed" ? "Confirmada" : "Cancelada"}</dd>
          <dt className="font-semibold">Servicio</dt>
          <dd>{booking.service}</dd>
          <dt className="font-semibold">Profesional</dt>
          <dd>{booking.professional}</dd>
          <dt className="font-semibold">Hora local</dt>
          <dd>
            {booking.date} {booking.time}
          </dd>
          <dt className="font-semibold">Zona horaria</dt>
          <dd>{booking.timezone}</dd>
        </dl>
      )}
      {alternatives && (
        <p data-testid="alternatives-evidence" className="mt-2 rounded-md border border-stone-300 bg-stone-50 p-2 text-xs">
          La base de datos rechazó el horario. {alternatives.length} alternativas devueltas por la herramienta.
        </p>
      )}
    </>
  );
}

function degradedLabel(degraded: Reply["degraded"]): string | null {
  if (degraded === "handoff") return "Conversación transferida a una persona";
  if (degraded === "person_soon") return "Modo degradado: el asistente no pudo responder";
  if (degraded === "rate_limited") return "Límite de mensajes alcanzado";
  if (degraded === "over_budget") return "Presupuesto agotado: sin llamada al modelo";
  return null;
}

function Trace({ reply }: { reply: Reply }) {
  const tools = reply.trace.tools.map((tool) => `${tool.name} → ${tool.status}`).join(", ");
  const answeredBy = reply.trace.model ? `Modelo: ${reply.trace.model}` : "Sin llamada al modelo";
  return (
    <p data-testid="trace" className="mt-1 text-[11px] text-stone-600">
      {answeredBy}
      {tools ? ` · ${tools}` : ""}
    </p>
  );
}

export function ChatDemo() {
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [bubbles, pending]);

  async function send(text: string) {
    const body = text.trim();
    if (!body || pending) return;

    const messageId = crypto.randomUUID();
    setBubbles((current) => [...current, { id: messageId, from: "customer", text: body }]);
    setDraft("");
    setPending(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId, text: body }),
      });
      if (!response.ok) throw new Error(String(response.status));
      const { replies } = ChatResponseSchema.parse(await response.json());
      setBubbles((current) => [
        ...current,
        ...replies.map((reply, index): Bubble => ({ id: `${messageId}-${index}`, from: "clinic", reply })),
      ]);
    } catch {
      setBubbles((current) => [...current, { id: `${messageId}-notice`, from: "notice", text: UNAVAILABLE }]);
    } finally {
      setPending(false);
    }
  }

  async function restart() {
    setPending(true);
    await fetch("/api/chat", { method: "DELETE" }).catch(() => undefined);
    setBubbles([]);
    setDraft("");
    setPending(false);
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void send(draft);
  }

  return (
    <main className="mx-auto flex h-dvh w-full max-w-xl flex-col bg-[#efeae2] text-stone-900">
      <header className="flex items-center justify-between gap-3 bg-emerald-900 px-4 py-3 text-white">
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold">Fisio Aurora (demo)</h1>
          <p className="text-xs text-emerald-100">Clínica ficticia. No escribas datos reales ni de salud.</p>
        </div>
        <button
          type="button"
          onClick={() => void restart()}
          disabled={pending}
          className={`shrink-0 rounded-md border border-emerald-100 px-3 py-1 text-xs font-medium disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white`}
        >
          Reiniciar
        </button>
      </header>

      <section aria-label="Conversación" aria-live="polite" className="flex-1 space-y-2 overflow-y-auto px-4 py-4">
        {bubbles.length === 0 && (
          <p className="mx-auto max-w-sm rounded-md bg-white/70 p-3 text-center text-sm">
            Este chat usa el mismo asistente que WhatsApp. Escribe «Hola» para empezar, o usa los ejemplos de abajo.
          </p>
        )}

        {bubbles.map((bubble) => {
          if (bubble.from === "customer") {
            return (
              <div key={bubble.id} data-testid="customer-bubble" className="ml-auto w-fit max-w-[85%] rounded-lg bg-emerald-100 px-3 py-2 text-sm whitespace-pre-wrap break-words">
                {bubble.text}
              </div>
            );
          }
          if (bubble.from === "notice") {
            return (
              <p key={bubble.id} role="status" data-testid="notice" className="mx-auto w-fit max-w-[85%] rounded-md bg-amber-100 px-3 py-2 text-center text-xs">
                {bubble.text}
              </p>
            );
          }
          const label = degradedLabel(bubble.reply.degraded);
          return (
            <div key={bubble.id} data-testid="clinic-bubble" className="w-fit max-w-[85%] rounded-lg bg-white px-3 py-2 text-sm">
              {label && (
                <p data-testid="degraded" className="mb-1 text-xs font-semibold text-amber-900">
                  {label}
                </p>
              )}
              <p className="whitespace-pre-wrap break-words">{bubble.reply.text}</p>
              <Evidence reply={bubble.reply} />
              <Trace reply={bubble.reply} />
            </div>
          );
        })}

        {pending && (
          <p data-testid="typing" className="w-fit rounded-lg bg-white px-3 py-2 text-sm text-stone-600">
            Escribiendo…
          </p>
        )}
        <div ref={endRef} />
      </section>

      <div className="border-t border-stone-300 bg-stone-100 px-4 py-2">
        <ul aria-label="Mensajes de ejemplo" className="flex gap-2 overflow-x-auto pb-2">
          {SAMPLES.map((sample) => (
            <li key={sample} className="shrink-0">
              <button
                type="button"
                onClick={() => void send(sample)}
                disabled={pending}
                className={`rounded-full border border-stone-400 bg-white px-3 py-1 text-xs disabled:opacity-50 ${focusRing}`}
              >
                {sample}
              </button>
            </li>
          ))}
        </ul>
        <form onSubmit={onSubmit} className="flex gap-2">
          <label htmlFor="chat-input" className="sr-only">
            Mensaje
          </label>
          <input
            id="chat-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={1000}
            autoComplete="off"
            placeholder="Escribe un mensaje"
            className={`min-w-0 flex-1 rounded-md border border-stone-400 bg-white px-3 py-2 text-base ${focusRing}`}
          />
          <button
            type="submit"
            disabled={pending || draft.trim().length === 0}
            className={`rounded-md bg-emerald-800 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 ${focusRing}`}
          >
            Enviar
          </button>
        </form>
      </div>
    </main>
  );
}
