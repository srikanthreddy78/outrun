import { pino, type Logger } from "pino";

export type { Logger };

export const logger: Logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "test" || process.env.VITEST ? "silent" : "info"),
  redact: {
    paths: ["*.apiKey", "*.token", "*.secret", "*.authorization", "headers.authorization"],
    remove: true,
  },
});
