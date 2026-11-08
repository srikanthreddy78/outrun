"use server";
/**
 * The owner's client actions on /dashboard/clients: add a client, start its researcher on the
 * profile (after naive up gave it a crew), confirm the profile as edited, pause or resume, and
 * accept or reject the CEO's proposed profile changes.
 * Allowlisted team only; every action is a ledger event with actor user:<email>.
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { addClient, confirmProfile, setPaused, startProfiling } from "@outrun/core/clients";
import { applyProfileProposal, rejectProfileProposal } from "@outrun/core/insights";
import { auth } from "../auth";
import { getRuntime } from "./runtime";
import { dashboardAccess } from "./team-access";

async function owner(): Promise<string> {
  const session = await auth();
  const email = session?.user?.email;
  if (!email || !dashboardAccess(email, process.env.AUTH_GITHUB_ALLOWLIST ?? ""))
    throw new Error("Unauthorized");
  return `user:${email}`;
}

async function deps() {
  const rt = await getRuntime();
  return {
    db: rt.db.db,
    emit: rt.emit,
    enqueue: (j: Parameters<typeof rt.queue.enqueue>[0]) => rt.queue.enqueue(j),
  };
}

const lines = (v: FormDataEntryValue | null) =>
  String(v ?? "")
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);

export async function addClientAction(form: FormData): Promise<void> {
  const actor = await owner();
  await addClient(
    await deps(),
    {
      name: form.get("name"),
      domain: form.get("domain"),
      ...(form.get("slug") ? { slug: form.get("slug") } : {}),
      approverEmails: lines(form.get("approvers")),
    },
    actor,
  );
  revalidatePath("/dashboard/clients");
}

const Id = z.uuid();

export async function startProfilingAction(form: FormData): Promise<void> {
  const actor = await owner();
  await startProfiling(await deps(), Id.parse(form.get("clientId")), actor);
  revalidatePath("/dashboard/clients");
}

/** The edited profile arrives as one JSON field; the contract validates it before it's saved. */
export async function confirmProfileAction(form: FormData): Promise<void> {
  const actor = await owner();
  const raw = JSON.parse(String(form.get("profile") ?? "{}")) as unknown;
  await confirmProfile(await deps(), Id.parse(form.get("clientId")), raw, actor);
  revalidatePath("/dashboard/clients");
}

export async function pauseAction(form: FormData): Promise<void> {
  const actor = await owner();
  await setPaused(await deps(), Id.parse(form.get("clientId")), form.get("paused") === "true", actor);
  revalidatePath("/dashboard/clients");
}

/** Accept the CEO's proposal: the changes go into the confirmed profile, which stays confirmed. */
export async function acceptProposalAction(form: FormData): Promise<void> {
  const actor = await owner();
  await applyProfileProposal(
    await deps(),
    Id.parse(form.get("clientId")),
    Id.parse(form.get("proposalId")),
    actor,
  );
  revalidatePath("/dashboard/clients");
}

export async function rejectProposalAction(form: FormData): Promise<void> {
  const actor = await owner();
  await rejectProfileProposal(
    await deps(),
    Id.parse(form.get("clientId")),
    Id.parse(form.get("proposalId")),
    z
      .string()
      .max(500)
      .parse(String(form.get("reason") ?? "")),
    actor,
  );
  revalidatePath("/dashboard/clients");
}
