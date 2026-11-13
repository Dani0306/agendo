import type { Metadata } from "next";
import { Suspense } from "react";
import { requestMagicLink } from "../actions";

export const metadata: Metadata = { title: "Acceso al panel" };

const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800";

async function Status({ searchParams }: { searchParams: Promise<{ sent?: string; error?: string }> }) {
  const params = await searchParams;
  if (params.sent) {
    return (
      <p role="status" className="mt-4 rounded-md bg-emerald-50 p-3 text-sm text-emerald-900">
        Si tu correo tiene acceso, te llegará un enlace en un minuto. Ábrelo en este mismo navegador.
      </p>
    );
  }
  if (params.error) {
    return (
      <p role="alert" className="mt-4 rounded-md bg-amber-50 p-3 text-sm text-amber-900">
        El enlace no funcionó o venció. Pide uno nuevo.
      </p>
    );
  }
  return null;
}

export default function LoginPage({ searchParams }: PageProps<"/dashboard/login">) {
  return (
    <main className="mx-auto w-full max-w-sm bg-white px-4 py-16 text-stone-900">
      <h1 className="text-xl font-semibold">Panel de la clínica</h1>
      <p className="mt-2 text-sm text-stone-700">Te enviamos un enlace de acceso a tu correo. No hay contraseña.</p>
      <form action={requestMagicLink} className="mt-6 flex flex-col gap-3">
        <label htmlFor="email" className="text-sm font-medium">
          Correo
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          className={`rounded-md border border-stone-400 px-3 py-2 text-base ${focusRing}`}
        />
        <button type="submit" className={`rounded-md bg-emerald-800 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 ${focusRing}`}>
          Enviar enlace
        </button>
      </form>
      <Suspense fallback={null}>
        <Status searchParams={searchParams as Promise<{ sent?: string; error?: string }>} />
      </Suspense>
    </main>
  );
}
