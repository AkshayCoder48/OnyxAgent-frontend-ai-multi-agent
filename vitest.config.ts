import { defineConfig } from "vitest/config";
import path from "path";

/**
 * Vitest configuration.
 *
 * - Resolves the `@/*` path alias exactly like tsconfig.json / Next.js does,
 *   so store and component tests can import `@/lib/...` modules.
 * - Uses jsdom for component tests (button.test.tsx) and node for pure
 *   logic/store tests. The per-file `environmentMatchGlobs` keeps the
 *   default node environment fast while enabling DOM tests for .tsx files.
 */
export default defineConfig({
  test: {
    environment: "node",
    // globals: true lets @testing-library/react register its automatic
    // afterEach(cleanup) hook — without it, rendered components accumulate
    // across tests and "Found multiple elements" errors appear.
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./vitest.setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
