import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": fromRoot("./src"),
      // The package throws outside a react-server build; tests are server code.
      "server-only": fromRoot("./node_modules/server-only/empty.js"),
    },
  },
  test: {
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts", "supabase/functions/**/*.test.ts"],
    exclude: ["node_modules/**", ".next/**"],
  },
});
