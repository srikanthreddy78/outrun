import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.ts",
      "apps/web/app/**/*.test.ts",
      "scripts/**/*.test.ts",
      "*.test.ts",
    ],
    exclude: ["daybreak3/**", "**/node_modules/**"],
    environment: "node",
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
