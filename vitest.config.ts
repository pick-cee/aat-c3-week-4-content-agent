import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // `server-only` throws when imported outside a React Server Component,
      // which is exactly the guard we want in the app and exactly what breaks
      // a unit test. Aliasing it to an empty module keeps the guard real in
      // the Next build while letting the pure logic be tested directly.
      "server-only": fileURLToPath(new URL("./src/test/server-only-stub.ts", import.meta.url)),
    },
  },
});
