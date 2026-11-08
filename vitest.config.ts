import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

if (existsSync(".env")) process.loadEnvFile(".env");

export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "packages/*/contracts/**/*.test.ts",
      "apps/*/src/**/*.test.ts",
      "apps/web/app/**/*.test.ts",
      "apps/web/lib/**/*.test.ts",
      "scripts/**/*.test.ts",
      "*.test.ts",
    ],
    exclude: ["daybreak3/**", "**/node_modules/**"],
    environment: "node",
    alias: { "@/": new URL("./apps/web/", import.meta.url).pathname },
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
