"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { replayDeadJob as replay } from "@outrun/core/replay";
import { auth } from "../auth";
import { dashboardAccess } from "./team-access";
import { getRuntime } from "./runtime";

/** The dashboard's Replay button; the CEO's outrun.replay_job runs the same core replay. */
export async function replayDeadJob(formData: FormData): Promise<void> {
  const session = await auth();
  if (!dashboardAccess(session?.user?.email, process.env.AUTH_GITHUB_ALLOWLIST ?? ""))
    throw new Error("Unauthorized");
  const eventId = z.uuid().parse(formData.get("eventId"));
  const rt = await getRuntime();
  const r = await replay(
    { db: rt.db.db, emit: rt.emit, enqueue: (job) => rt.queue.enqueue(job) },
    { eventId },
    "user:dashboard",
  );
  if (!r.ok) throw new Error(r.reason);
  revalidatePath("/dashboard/health");
}
