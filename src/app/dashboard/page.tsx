import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { sessionClient, signedInUserId } from "@/lib/auth/server";
import { spanishDate } from "@/lib/booking/timezone";
import { formatUsd } from "@/lib/dashboard/metrics";
import { type DashboardData, loadDashboard } from "@/lib/db/dashboard";
import { signOut } from "./actions";

export const metadata: Metadata = { title: "Panel de la clínica" };

const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800";

function localDateTime(instant: Date | string, timezone: string): string {
  return new Intl.DateTimeFormat("es-CO", { timeZone: timezone, dateStyle: "medium", timeStyle: "short" })
    .format(new Date(instant))
    .replace(/ /g, " ");
}

function Tile({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-md border border-stone-300 bg-white p-4">
      <p className="text-xs font-medium text-stone-600">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {detail && <p className="mt-1 text-xs text-stone-600">{detail}</p>}
    </div>
  );
}

/** One series, one hue: bars rounded at the data end, a 2px gap, a label on hover, and a table view. */
function MessagesChart({ days }: { days: DashboardData extends null ? never : NonNullable<DashboardData>["messagesPerDay"] }) {
  const max = Math.max(1, ...days.map((day) => day.total));
  return (
    <figure>
      <div className="flex h-40 items-end gap-[2px] border-b border-stone-300" role="img" aria-label="Mensajes por día, últimos 14 días">
        {days.map((day) => (
          <div
            key={day.date}
            title={`${spanishDate(day.date)}: ${day.total} mensajes`}
            className="group relative flex h-full flex-1 items-end"
          >
            <div className="w-full rounded-t-[4px] bg-emerald-700" style={{ height: `${(day.total / max) * 100}%`, minHeight: day.total > 0 ? 2 : 0 }} />
          </div>
        ))}
      </div>
      <figcaption className="mt-1 flex justify-between text-xs text-stone-600">
        <span>{spanishDate(days[0]!.date)}</span>
        <span>hoy</span>
      </figcaption>
      <details className="mt-2 text-sm">
        <summary className={`cursor-pointer text-stone-700 ${focusRing}`}>Ver como tabla</summary>
        <table className="mt-2 w-full text-left text-sm">
          <thead>
            <tr className="text-stone-600">
              <th className="py-1 font-medium">Día</th>
              <th className="py-1 text-right font-medium">Mensajes</th>
            </tr>
          </thead>
          <tbody>
            {days.map((day) => (
              <tr key={day.date} className="border-t border-stone-200">
                <td className="py-1">{spanishDate(day.date)}</td>
                <td className="py-1 text-right tabular-nums">{day.total}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

async function Dashboard() {
  const client = await sessionClient();
  if (!(await signedInUserId(client))) redirect("/dashboard/login");

  const data = await loadDashboard(client, new Date());
  if (!data) {
    return (
      <p className="rounded-md bg-amber-50 p-4 text-sm text-amber-900">
        Tu cuenta no tiene ninguna clínica asignada todavía. Pide acceso al administrador.
      </p>
    );
  }

  const { tenant, totals } = data;
  const zone = `hora de ${tenant.timezone}`;
  const ms = (value: number | null) => (value === null ? "—" : `${(value / 1000).toFixed(1)} s`);

  return (
    <>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{tenant.name}</h1>
          <p className="text-sm text-stone-600">Este mes · costos tomados de model_calls · {zone}</p>
        </div>
        <form action={signOut}>
          <button type="submit" className={`rounded-md border border-stone-400 px-3 py-1 text-sm ${focusRing}`}>
            Cerrar sesión
          </button>
        </form>
      </header>

      <section aria-label="Totales del mes" className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Conversaciones" value={String(totals.conversations)} />
        <Tile label="Citas creadas" value={String(totals.bookings)} />
        <Tile
          label="Costo de modelo"
          value={formatUsd(totals.modelCostUsd)}
          detail={`${totals.modelCalls} llamadas · ${totals.failedCalls} fallidas · ${totals.fallbackCalls} por el modelo de respaldo`}
        />
        <Tile label="Latencia (p50 / p95)" value={`${ms(totals.latencyP50)} / ${ms(totals.latencyP95)}`} detail="llamadas al modelo exitosas" />
      </section>

      <section className="mt-8">
        <h2 className="text-base font-semibold">Mensajes por día</h2>
        <div className="mt-3">
          <MessagesChart days={data.messagesPerDay} />
        </div>
      </section>

      <div className="mt-8 grid gap-8 lg:grid-cols-2">
        <section>
          <h2 className="text-base font-semibold">Próximas citas</h2>
          {data.upcoming.length === 0 ? (
            <p className="mt-2 text-sm text-stone-600">No hay citas próximas.</p>
          ) : (
            <table className="mt-2 w-full text-left text-sm">
              <thead>
                <tr className="text-stone-600">
                  <th className="py-1 font-medium">Cuándo ({zone})</th>
                  <th className="py-1 font-medium">Servicio</th>
                  <th className="py-1 font-medium">Profesional</th>
                </tr>
              </thead>
              <tbody>
                {data.upcoming.map((booking) => (
                  <tr key={booking.id} className="border-t border-stone-200">
                    <td className="py-1">{localDateTime(booking.start, tenant.timezone)}</td>
                    <td className="py-1">{booking.service}</td>
                    <td className="py-1">{booking.professional}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section>
          <h2 className="text-base font-semibold">Conversaciones recientes</h2>
          <table className="mt-2 w-full text-left text-sm">
            <thead>
              <tr className="text-stone-600">
                <th className="py-1 font-medium">Paciente</th>
                <th className="py-1 font-medium">Canal</th>
                <th className="py-1 font-medium">Estado</th>
                <th className="py-1 font-medium">Último mensaje</th>
              </tr>
            </thead>
            <tbody>
              {data.recent.map((conversation) => (
                <tr key={conversation.id} className="border-t border-stone-200">
                  <td className="py-1">{conversation.customer}</td>
                  <td className="py-1">{conversation.channel === "whatsapp" ? "WhatsApp" : "Web"}</td>
                  <td className="py-1">{conversation.status === "handoff" ? "Con una persona" : conversation.status === "open" ? "Abierta" : "Cerrada"}</td>
                  <td className="py-1">{conversation.lastMessageAt ? localDateTime(conversation.lastMessageAt, tenant.timezone) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      <section className="mt-8">
        <h2 className="text-base font-semibold">Costo de modelo por día (USD)</h2>
        <table className="mt-2 w-full max-w-md text-left text-sm">
          <tbody>
            {data.costPerDay.map((day) => (
              <tr key={day.date} className="border-t border-stone-200">
                <td className="py-1">{spanishDate(day.date)}</td>
                <td className="py-1 text-right tabular-nums">{formatUsd(day.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

export default function DashboardPage() {
  return (
    <main className="mx-auto w-full max-w-5xl bg-stone-50 px-4 py-8 text-stone-900">
      <Suspense fallback={<p className="text-sm text-stone-600">Cargando el panel…</p>}>
        <Dashboard />
      </Suspense>
    </main>
  );
}
