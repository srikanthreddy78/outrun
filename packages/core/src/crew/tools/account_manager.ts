/**
 * The account manager's tools (a role the CEO staffs with outrun.staff_client):
 *   client_weekly_report  code builds the week's numbers and goal; the agent adds a short note;
 *                         saved as client.report; code emails the approvers a fixed notice
 *   client_questions      the client's portal questions, wrapped as untrusted
 *   answer_client         an answer the client reads in its portal, grounded like a reply
 */
import { randomUUID } from "node:crypto";
import { untrusted } from "../../../contracts";
import { answerClientQuestion, clientQuestions, noteProblems, type ClientReport } from "../../accountManager";
import { CRON_TZ, OUTRUN_CLIENT_ID } from "../../constants";
import { and, count, eq } from "drizzle-orm";
import { clientUsers } from "../../db/schema";
import { AppError } from "../../errors";
import { goalProgress } from "../../insights";
import { dayIn } from "../../time";
import { defineTool } from "../registry";
import { clientById, clientNumbers } from "./agency";

const WEEK = 7 * 86_400_000;

export const clientWeeklyReport = defineTool({
  name: "client_weekly_report",
  handler: async ({ note }, ctx) => {
    if (ctx.clientId === OUTRUN_CLIENT_ID) throw new AppError("bad_request", "Outrun has no account manager");
    const c = await clientById(ctx.db, ctx.clientId);
    const problems = note ? noteProblems(note) : [];
    if (problems.length) throw new AppError("bad_request", problems.join("; "));
    const now = ctx.now();
    const since = new Date(now.getTime() - WEEK);
    const day = dayIn(CRON_TZ, now);
    const n = await clientNumbers(ctx.db, c.id, since, now);
    const report: ClientReport = {
      day,
      since: since.toISOString(),
      sent: n.sent,
      replies: n.replies,
      won: n.won,
      approvalsWaiting: n.approvalsWaiting,
      stages: n.stages,
      goal: await goalProgress(ctx.db, c.id, now),
      note: note ?? null,
    };
    const reportId = randomUUID();
    await ctx.emit({
      actor: `naive:${ctx.agent}`,
      type: "client.report",
      entityType: "client",
      entityId: c.id,
      payload: { reportId, report },
    });
    // One notice a day, however often the report is saved; the latest is what the portal shows.
    const { jobId } = await ctx.enqueue({
      type: "send_client_report",
      payload: { clientId: c.id, reportId },
      idempotencyKey: `client-report:${c.id}:${day}`,
      traceId: ctx.requestId,
    });
    const [approvers] = await ctx.db
      .select({ n: count() })
      .from(clientUsers)
      .where(and(eq(clientUsers.clientId, c.id), eq(clientUsers.role, "approver")));
    return { reportId, report, notified: jobId === null ? 0 : Number(approvers?.n ?? 0) };
  },
});

export const clientQuestionsTool = defineTool({
  name: "client_questions",
  handler: async ({ limit, unansweredOnly }, ctx) => {
    const qs = await clientQuestions(ctx.db, ctx.clientId, 50);
    return {
      questions: qs
        .filter((q) => !unansweredOnly || !q.answer)
        .slice(0, limit)
        .map((q) => ({
          questionId: q.questionId,
          question: untrusted(q.question),
          at: q.at.toISOString(),
          answered: q.answer !== null,
        })),
    };
  },
});

export const answerClient = defineTool({
  name: "answer_client",
  handler: async ({ questionId, answer }, ctx) =>
    answerClientQuestion(
      { db: ctx.db, emit: ctx.emit },
      ctx.clientId,
      questionId,
      answer,
      `naive:${ctx.agent}`,
    ),
});

export const accountManagerTools = [clientWeeklyReport, clientQuestionsTool, answerClient];
