/**
 * pnpm email:resume "<why>": resumes outreach after an auto-pause (a complaint, or bounces past
 * 3% of the last 50 sends). Records who resumed and why; sends nothing itself.
 */
import { config } from "../packages/core/src/config";
import { createDb } from "../packages/core/src/db/client";
import { sendPause } from "../packages/core/src/email/rules";
import { createEmitter } from "../packages/core/src/events";

async function main() {
  const why = process.argv.slice(2).join(" ").trim();
  if (!why) throw new Error('say why: pnpm email:resume "fixed the list source"');
  const c = config();
  const db = createDb(c.databaseUrlUnpooled ?? c.databaseUrl!, { max: 1 });
  const before = await sendPause(db.db);
  console.log(before.paused ? `paused: ${before.reason}` : "not paused");
  await createEmitter(db.db)({
    actor: "system",
    type: "email.resumed",
    entityType: "system",
    entityId: "email",
    payload: { why: why.slice(0, 500), wasPaused: before.paused, reason: before.reason },
  });
  console.log("resumed");
  await db.pool.end();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
