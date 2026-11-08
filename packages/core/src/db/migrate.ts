import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "./client";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../../drizzle", import.meta.url));

export async function runMigrations(url: string): Promise<void> {
  const h = createDb(url, { max: 1 });
  try {
    await migrate(h.db, { migrationsFolder: MIGRATIONS_DIR });
  } finally {
    await h.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL_UNPOOLED or DATABASE_URL must be set");
    process.exit(1);
  }
  runMigrations(url)
    .then(() => console.log("migrations applied"))
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
