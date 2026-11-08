/**
 * pnpm eval:triage: scores the real bulk model on the 30 fixture replies (SH-7's bar: 27 right,
 * injection attempts included). Spends a few cents of OpenRouter/OpenAI credit: ask first.
 * Runs against a throwaway database; sends nothing and starts no sessions.
 */
import { config } from "../packages/core/src/config";
import { createRuntime } from "../packages/core/src/runtime";
import { companies, contacts, messages, prospects } from "../packages/core/src/db/schema";
import { FIXTURE_REPLIES } from "../packages/core/src/testing/replies";
import { createTempDatabase } from "../packages/core/src/testing/db";
import { runTriage } from "../packages/core/src/triage";

const BAR = 27;

async function main() {
  const t = await createTempDatabase();
  const rt = await createRuntime(
    { ...config(), databaseUrl: t.url, databaseUrlUnpooled: t.url },
    { startQueue: false },
  );
  let right = 0;
  let i = 0;
  try {
    for (const r of FIXTURE_REPLIES) {
      i++;
      const [co] = await t.db
        .insert(companies)
        .values({ domain: `ev${i}.dev`, name: "E", source: "fixture", kind: "prospect" })
        .returning();
      const [c] = await t.db
        .insert(contacts)
        .values({ companyId: co!.id, name: "E", email: `e@ev${i}.dev`, sourceUrl: `https://ev${i}.dev` })
        .returning();
      const [p] = await t.db
        .insert(prospects)
        .values({ companyId: co!.id, contactId: c!.id, stage: "replied" })
        .returning();
      const [m] = await t.db
        .insert(messages)
        .values({
          prospectId: p!.id,
          contactId: c!.id,
          threadId: `th_${i}`,
          direction: "inbound",
          kind: "inbound",
          status: "received",
          fromEmail: r.from,
          subject: r.subject,
          body: r.body,
        })
        .returning();
      const out = await runTriage(
        { db: t.db, emit: rt.emit, llm: rt.llm, appUrl: rt.config.appUrl, enqueue: async () => ({}) },
        m!.id,
      );
      const ok = out.label === r.want;
      if (ok) right++;
      console.log(
        `${ok ? "ok  " : "MISS"} ${r.want.padEnd(11)} got ${out.label.padEnd(11)}${r.injection ? " (injection)" : ""}  ${r.body.slice(0, 60).replace(/\n/g, " ")}`,
      );
    }
  } finally {
    await rt.close();
    await t.drop();
  }
  console.log(`\n${right}/${FIXTURE_REPLIES.length} right (bar ${BAR})`);
  if (right < BAR) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
