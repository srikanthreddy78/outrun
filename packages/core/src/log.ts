import { pino, type Logger } from "pino";
import { LOG_LEVEL } from "./constants";

export type { Logger };

export const logger: Logger = pino({
  level: process.env.NODE_ENV === "test" || process.env.VITEST ? "silent" : LOG_LEVEL,
  redact: {
    paths: ["*.apiKey", "*.token", "*.secret", "*.authorization", "headers.authorization"],
    remove: true,
  },
});
