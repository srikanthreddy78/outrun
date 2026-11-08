/**
 * pnpm db:seed [--domain d --name n --contact c --inbox e]: seeds the demo prospect,
 * idempotently. In production pass a teammate's real domain and inbox; without flags it seeds
 * a placeholder that can't receive mail.
 */
import { parseArgs } from "node:util";
import { createDb } from "@outrun/core/db";
import { logger } from "@outrun/core/log";
import { DEMO_PLACEHOLDER, seedDemo } from "@outrun/core/seed";
import { z } from "zod";

const { values } = parseArgs({
  options: {
    domain: { type: "string" },
    name: { type: "string" },
    contact: { type: "string" },
    inbox: { type: "string" },
  },
});

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const demo = {
    domain: values.domain ?? DEMO_PLACEHOLDER.domain,
    name: values.name ?? DEMO_PLACEHOLDER.name,
    contactName: values.contact ?? DEMO_PLACEHOLDER.contactName,
    inbox: z.email().parse(values.inbox ?? DEMO_PLACEHOLDER.inbox),
  };
  if (!values.inbox) logger.warn({ inbox: demo.inbox }, "no --inbox given; seeding the placeholder");
  const db = createDb(url, { max: 1 });
  try {
    const ids = await seedDemo(db.db, demo);
    logger.info({ domain: demo.domain, ...ids }, "demo prospect seeded");
  } finally {
    await db.close();
  }
}

main().catch((err: unknown) => {
  logger.fatal({ err }, "seed failed");
  process.exit(1);
});
