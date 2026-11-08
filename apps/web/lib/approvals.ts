"use server";
/**
 * SH-5: approve or reject held sends from /dashboard/approvals. The decision goes to Naive
 * (confirmTool), which enforces it; the next session.idle records it on the draft. Our code
 * never marks a draft approved itself.
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { auth } from "../auth";
import { submitDecisions } from "./approvals-core";
import { getRuntime } from "./runtime";
import { dashboardAccess } from "./team-access";

const Form = z.object({
  ids: z.array(z.uuid()).min(1).max(50),
  decision: z.enum(["allow", "deny"]),
  reason: z.string().max(500).default(""),
});

export async function decideApprovals(formData: FormData): Promise<void> {
  const session = await auth();
  const email = session?.user?.email;
  if (!email || !dashboardAccess(email, process.env.AUTH_GITHUB_ALLOWLIST ?? ""))
    throw new Error("Unauthorized");
  const f = Form.parse({
    ids: formData.getAll("ids"),
    decision: formData.get("decision"),
    reason: formData.get("reason") ?? "",
  });
  await submitDecisions(await getRuntime(), email, f);
  revalidatePath("/dashboard/approvals");
}
