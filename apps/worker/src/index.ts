import { pino } from "pino";
import { APP_NAME } from "@outrun/core";

const log = pino({ name: "worker" });

async function main(): Promise<void> {
  log.info({ app: APP_NAME }, "worker ready");
}

main().catch((err: unknown) => {
  log.fatal({ err }, "worker failed to start");
  process.exit(1);
});
