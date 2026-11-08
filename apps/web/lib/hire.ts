"use server";
/**
 * /hire: a company hires the agency itself, a free trial with no payment. The same core
 * function as the public hire_agency tool; the owner still confirms the profile.
 */
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppError } from "@outrun/core";
import { logger } from "@outrun/core/log";
import { callerHash } from "@outrun/core/public/service";
import { hireAgency } from "@outrun/core/selfServe";
import { getRuntime } from "./runtime";

export async function hireAction(form: FormData): Promise<void> {
  const h = await headers();
  const ip = h.get("x-real-ip") ?? h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  let to: string;
  try {
    const rt = await getRuntime();
    const out = await hireAgency(
      {
        db: rt.db.db,
        emit: rt.emit,
        enqueue: (j) => rt.queue.enqueue(j),
        sendTransactional: rt.integrations.sendTransactional,
        appUrl: rt.config.appUrl,
        secret: rt.config.keys.crewTokenSecret,
      },
      {
        companyName: String(form.get("companyName") ?? ""),
        domain: String(form.get("domain") ?? ""),
        approverEmail: String(form.get("approverEmail") ?? ""),
      },
      { channel: "web", caller: callerHash(ip) },
    );
    to = `/hire?${out.created ? "hired" : "known"}=${encodeURIComponent(out.slug)}`;
  } catch (err) {
    const e = err instanceof AppError ? err : null;
    if (!e || e.code === "internal") logger.error({ err }, "hire failed");
    const why =
      e && (e.code === "bad_request" || e.code === "rate_limited")
        ? e.message
        : "Something went wrong; try again later.";
    to = `/hire?error=${encodeURIComponent(why.slice(0, 300))}`;
  }
  redirect(to);
}
