import { expect, test } from "@playwright/test";

// Signed-in pages need a real magic link, so they're tested by hand (prompt 005).

test("a signed-out visitor to the dashboard is sent to the login", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/dashboard\/login$/);
  await expect(page.getByRole("heading", { name: "Panel de la clínica" })).toBeVisible();
});

test("the login asks only for an email and has no password field", async ({ page }) => {
  await page.goto("/dashboard/login");
  await expect(page.getByLabel("Correo")).toBeVisible();
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Enviar enlace" })).toBeEnabled();
});

test("the privacy page says it's a draft without legal review", async ({ page }) => {
  await page.goto("/privacidad");
  await expect(page.getByRole("note")).toContainText("Borrador sin revisión legal");
  await expect(page.getByRole("heading", { name: "Cuánto tiempo los guardamos" })).toBeVisible();
});
