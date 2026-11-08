"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { JobEnvelope, JobType } from "@outrun/core/contracts";
import { eq, events } from "@outrun/core/db/query";
import { deadLetterName } from "@outrun/core/queue";
import { auth } from "../auth";
import { dashboardAccess } from "./team-access";
import { getRuntime } from "./runtime";
import { REPLAYABLE_JOBS } from "./replayable-jobs";

export async function replayDeadJob(formData: FormData): Promise<void> {
  const session = await auth();
  if (!dashboardAccess(session?.user?.email, process.env.AUTH_GITHUB_ALLOWLIST ?? ""))
    throw new Error("Unauthorized");
  const eventId = z.uuid().parse(formData.get("eventId"));
  const rt = await getRuntime();
  const [event] = await rt.db.db.select().from(events).where(eq(events.id, eventId));
  if (!event || event.type !== "job.dead") throw new Error("Dead job not found");
  const type = JobType.parse(event.payload.job);
  const jobId = event.payload.jobId;
  if (!REPLAYABLE_JOBS.has(type) || typeof jobId !== "string")
    throw new Error("This job cannot be replayed here");
  const dead = await rt.queue.boss.getJobById(deadLetterName(type), jobId);
  const parsed = JobEnvelope.safeParse(dead?.data);
  if (!parsed.success || parsed.data.type !== type) throw new Error("Dead job payload unavailable");
  const queued = await rt.queue.enqueue({
    ...parsed.data,
    idempotencyKey: `replay:${event.id}`,
    traceId: `replay-${event.id}`,
  });
  if (queued.jobId)
    await rt.emit({
      actor: "user:dashboard",
      type: "job.replayed",
      entityType: "job",
      entityId: jobId,
      payload: { type, deadEventId: event.id },
    });
  revalidatePath("/dashboard/health");
}
