"use server";
/**
 * The client portal's actions: ask for a sign-in link, use it, sign out, and approve or reject
 * the client's own held emails. Decisions go to Naive exactly as from /dashboard/approvals, but
 * only for messages of a client the signed-in approver belongs to. Approvers can also ask their
 * account manager a question.
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { AppError, config } from "@outrun/core";
import { askClientQuestion } from "@outrun/core/accountManager";
import { CLIENT_QUESTION_MAX_CHARS } from "@outrun/core/constants";
import { clients, eq } from "@outrun/core/db/query";
import {
  assertPortalAccess,
  PORTAL_COOKIE,
  PORTAL_SESSION_DAYS,
  redeemPortalLink,
  requestPortalLink,
} from "@outrun/core/portal";
import { startVerifiedCrews } from "@outrun/core/selfServe";
import { submitDecisions } from "./approvals-core";
import { portalEmail } from "./portal-session";
import { getRuntime } from "./runtime";

export async function requestLinkAction(form: FormData): Promise<void> {
  const rt = await getRuntime();
  const c = config();
  await requestPortalLink(
    {
      db: rt.db.db,
      sendTransactional: rt.integrations.sendTransactional,
      appUrl: c.appUrl,
      secret: c.keys.crewTokenSecret,
    },
    String(form.get("email") ?? ""),
  );
  // The same answer whether or not the address is an approver.
  redirect("/portal?sent=1");
}

export async function signInAction(form: FormData): Promise<void> {
  const rt = await getRuntime();
  const out = await redeemPortalLink(
    { db: rt.db.db, secret: config().keys.crewTokenSecret },
    String(form.get("token") ?? ""),
  );
  if (!out) redirect("/portal?expired=1");
  // A self-serve client's crew starts once its approver proves they read its mail.
  await startVerifiedCrews({ db: rt.db.db, emit: rt.emit, enqueue: (j) => rt.queue.enqueue(j) }, out.email);
  const jar = await cookies();
  jar.set(PORTAL_COOKIE, out.session, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/portal",
    maxAge: PORTAL_SESSION_DAYS * 86_400,
  });
  redirect("/portal");
}

export async function signOutAction(): Promise<void> {
  (await cookies()).delete({ name: PORTAL_COOKIE, path: "/portal" });
  redirect("/portal");
}

const Decision = z.object({
  slug: z.string().min(2).max(40),
  ids: z.array(z.uuid()).min(1).max(50),
  decision: z.enum(["allow", "deny"]),
  reason: z.string().max(500).default(""),
});

export async function portalDecideAction(form: FormData): Promise<void> {
  const email = await portalEmail();
  if (!email) throw new Error("Unauthorized");
  const f = Decision.parse({
    slug: form.get("slug"),
    ids: form.getAll("ids"),
    decision: form.get("decision"),
    reason: form.get("reason") ?? "",
  });
  const rt = await getRuntime();
  const [c] = await rt.db.db.select({ id: clients.id }).from(clients).where(eq(clients.slug, f.slug));
  if (!c) throw new Error("Unauthorized");
  await assertPortalAccess(rt.db.db, email, c.id);
  await submitDecisions(rt, email, f, { clientId: c.id });
  revalidatePath(`/portal/${f.slug}`);
}

const Question = z.object({
  slug: z.string().min(2).max(40),
  question: z.string().trim().min(1).max(CLIENT_QUESTION_MAX_CHARS),
});

/**
 * "Ask your account manager": stored as client.question. A staffed account manager's session
 * starts; otherwise the CEO sees it in agency_status. Rate-limited per client per day.
 */
export async function portalAskAction(form: FormData): Promise<void> {
  const email = await portalEmail();
  if (!email) throw new Error("Unauthorized");
  const parsed = Question.safeParse({ slug: form.get("slug"), question: form.get("question") ?? "" });
  if (!parsed.success) redirect(`/portal/${String(form.get("slug") ?? "")}?asked=invalid`);
  const f = parsed.data;
  const rt = await getRuntime();
  const [c] = await rt.db.db.select({ id: clients.id }).from(clients).where(eq(clients.slug, f.slug));
  if (!c) throw new Error("Unauthorized");
  await assertPortalAccess(rt.db.db, email, c.id);
  let to: string;
  try {
    const out = await askClientQuestion(
      { db: rt.db.db, emit: rt.emit, enqueue: (j) => rt.queue.enqueue(j) },
      c.id,
      email,
      f.question,
    );
    to = `/portal/${f.slug}?asked=${out.routed}`;
  } catch (err) {
    if (err instanceof AppError && err.code === "rate_limited") to = `/portal/${f.slug}?asked=limit`;
    else throw err;
  }
  revalidatePath(`/portal/${f.slug}`);
  redirect(to);
}
