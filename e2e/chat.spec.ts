import { expect, type Page, test } from "@playwright/test";

const trace = { model: "gpt-6-luna", tools: [{ name: "create_booking", status: "booked" }] };
const noModel = { model: null, tools: [] };

const booking = {
  service: "Valoración inicial",
  professional: "Laura",
  date: "2026-11-10",
  time: "10:00",
  dateText: "martes 10 de noviembre de 2026",
  timeText: "10:00 a. m.",
  timezone: "America/Bogota",
  status: "confirmed",
};

const option = { date: "2026-11-10", time: "11:00", dateText: "martes 10 de noviembre de 2026", timeText: "11:00 a. m.", professional: "Laura" };

async function stubChat(page: Page, replies: object[]) {
  await page.route("**/api/chat", (route) => route.fulfill({ json: { replies } }));
}

async function send(page: Page, text: string) {
  await page.getByLabel("Mensaje", { exact: true }).fill(text);
  await page.getByRole("button", { name: "Enviar" }).click();
}

test("shows a confirmed booking with the row the database accepted", async ({ page }) => {
  await stubChat(page, [{ text: "Tu cita quedó confirmada.", booking, trace }]);
  await page.goto("/");
  await send(page, "Quiero una cita");

  await expect(page.getByTestId("customer-bubble")).toHaveText("Quiero una cita");
  await expect(page.getByTestId("clinic-bubble")).toContainText("Tu cita quedó confirmada.");
  const evidence = page.getByTestId("booking-evidence");
  await expect(evidence).toContainText("Confirmada");
  await expect(evidence).toContainText("Laura");
  await expect(evidence).toContainText("2026-11-10 10:00");
  await expect(evidence).toContainText("America/Bogota");
  await expect(page.getByTestId("trace")).toContainText("gpt-6-luna");
  await expect(page.getByTestId("trace")).toContainText("create_booking → booked");
});

test("shows a rejected slot with its alternatives", async ({ page }) => {
  await stubChat(page, [
    {
      text: "Ese horario acaba de ocuparse. Estas son otras opciones:",
      alternatives: [option],
      trace: { model: "gpt-6-luna", tools: [{ name: "create_booking", status: "slot_taken" }] },
    },
  ]);
  await page.goto("/");
  await send(page, "A las 10");

  await expect(page.getByTestId("clinic-bubble")).toContainText("acaba de ocuparse");
  await expect(page.getByTestId("alternatives-evidence")).toContainText("1 alternativas");
  await expect(page.getByTestId("booking-evidence")).toHaveCount(0);
});

test("shows the degraded reply as a designed state, not an error", async ({ page }) => {
  await stubChat(page, [{ text: "Una persona de la clínica te escribirá pronto.", degraded: "person_soon", trace: noModel }]);
  await page.goto("/");
  await send(page, "hola");

  await expect(page.getByTestId("clinic-bubble")).toContainText("Una persona");
  await expect(page.getByTestId("degraded")).toContainText("Modo degradado");
  await expect(page.getByTestId("trace")).toContainText("Sin llamada al modelo");
});

test("shows the over-budget and rate-limited states", async ({ page }) => {
  await stubChat(page, [
    { text: "En este momento no puedo responder automáticamente.", degraded: "over_budget", trace: noModel },
    { text: "Estás enviando mensajes muy rápido.", degraded: "rate_limited", trace: noModel },
  ]);
  await page.goto("/");
  await send(page, "hola");

  await expect(page.getByTestId("degraded").first()).toContainText("Presupuesto agotado");
  await expect(page.getByTestId("degraded").last()).toContainText("Límite de mensajes");
});

test("shows a handoff", async ({ page }) => {
  await stubChat(page, [{ text: "Le pasé tu conversación a una persona.", degraded: "handoff", trace: noModel }]);
  await page.goto("/");
  await send(page, "Quiero hablar con alguien");

  await expect(page.getByTestId("degraded")).toContainText("transferida a una persona");
});

test("shows a notice when the server fails", async ({ page }) => {
  await page.route("**/api/chat", (route) => route.fulfill({ status: 404, body: "Not found" }));
  await page.goto("/");
  await send(page, "hola");

  await expect(page.getByTestId("notice")).toContainText("No pudimos conectar");
});

test("sends the sample messages and disables input while waiting", async ({ page }) => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/chat", async (route) => {
    await held;
    await route.fulfill({ json: { replies: [{ text: "Listo", trace: noModel }] } });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Hola", exact: true }).click();

  await expect(page.getByTestId("typing")).toBeVisible();
  await expect(page.getByRole("button", { name: "ACEPTO" })).toBeDisabled();
  release();
  await expect(page.getByTestId("clinic-bubble")).toContainText("Listo");
  await expect(page.getByRole("button", { name: "ACEPTO" })).toBeEnabled();
});

test("restart clears the conversation", async ({ page }) => {
  await page.route("**/api/chat", (route) =>
    route.request().method() === "DELETE"
      ? route.fulfill({ status: 204, body: "" })
      : route.fulfill({ json: { replies: [{ text: "Hola", trace: noModel }] } }),
  );
  await page.goto("/");
  await send(page, "hola");
  await expect(page.getByTestId("clinic-bubble")).toBeVisible();

  await page.getByRole("button", { name: "Reiniciar" }).click();
  await expect(page.getByTestId("clinic-bubble")).toHaveCount(0);
});

test("has no horizontal scroll at phone width", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 700 });
  await page.goto("/");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
