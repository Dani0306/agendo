import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Política de privacidad (borrador)",
  description: "Cómo trata Agendo los datos de las personas que escriben a una clínica. Borrador sin revisión legal.",
};

const section = "mt-8 text-lg font-semibold";
const paragraph = "mt-3 leading-relaxed";

/** Draft terms for the demo clinic. A lawyer must review them before a real clinic uses Agendo. */
export default function PrivacyPage() {
  return (
    <main className="mx-auto w-full max-w-2xl bg-white px-4 py-10 text-stone-900">
      <p role="note" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
        <strong>Borrador sin revisión legal.</strong> Este texto lo escribió una persona que no es abogada, para una clínica de
        demostración con datos ficticios. Ninguna clínica real debe usar Agendo con pacientes reales sin que un abogado revise
        estos términos.
      </p>

      <h1 className="mt-6 text-2xl font-semibold">Política de tratamiento de datos personales</h1>
      <p className={paragraph}>
        Esta política explica cómo el asistente de citas de la clínica (Agendo) trata los datos de quienes escriben por WhatsApp
        o por el chat web, según la Ley 1581 de 2012 y el Decreto 1377 de 2013 de Colombia.
      </p>

      <h2 className={section}>Qué datos tratamos y para qué</h2>
      <ul className="mt-3 list-disc space-y-1 pl-6 leading-relaxed">
        <li>Tu número de WhatsApp, guardado cifrado, para responderte y enviarte recordatorios de tus citas.</li>
        <li>Tu nombre, si nos lo das, para dirigirnos a ti.</li>
        <li>Tus mensajes y los datos de tus citas (servicio, profesional, fecha y hora), para agendarlas, cambiarlas o cancelarlas.</li>
      </ul>
      <p className={paragraph}>
        No pedimos síntomas, diagnósticos, medicamentos ni documentos de identidad. Si los escribes, los tratamos como datos
        sensibles y se borran con el resto de tus mensajes.
      </p>

      <h2 className={section}>Datos sensibles y tu autorización</h2>
      <p className={paragraph}>
        Como los datos de tus citas pueden revelar información de salud, son datos sensibles. No estás obligado(a) a autorizar su
        tratamiento. Solo los tratamos si respondes ACEPTO; si respondes NO, no los usamos y borramos tu número.
      </p>

      <h2 className={section}>Quién más los procesa</h2>
      <p className={paragraph}>
        Para funcionar, el asistente usa proveedores ubicados en Estados Unidos: OpenAI (el modelo que redacta las respuestas),
        Twilio (WhatsApp), Supabase (la base de datos) y Vercel (el sitio web). Ninguno recibe tu número de teléfono en claro salvo
        Twilio, que lo necesita para entregar el mensaje.
      </p>

      <h2 className={section}>Cuánto tiempo los guardamos</h2>
      <p className={paragraph}>
        El texto de tus mensajes se borra 90 días después de enviado. Si no escribes ni tienes citas durante 12 meses, borramos tu
        registro completo: número, nombre, conversaciones y citas. Los costos de operación se conservan sin datos que te
        identifiquen.
      </p>

      <h2 className={section}>Tus derechos</h2>
      <p className={paragraph}>
        Puedes conocer, actualizar y rectificar tus datos, pedir que los borremos, revocar tu autorización y presentar quejas ante la
        Superintendencia de Industria y Comercio. Para ejercerlos, escribe «quiero hablar con una persona» en el chat y la clínica te
        atenderá.
      </p>
    </main>
  );
}
