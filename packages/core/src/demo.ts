/**
 * OUTRUN_DEMO: Stripe in test mode (config refuses a live key), email only to a seeded demo
 * inbox, discovery only from fixtures. Send and discovery code call these guards.
 */
import type { Db } from "./db/client";
import { AppError } from "./errors";
import { demoInboxes } from "./seed";

export async function assertDemoRecipient(db: Db, settings: { demo: boolean }, to: string): Promise<void> {
  if (!settings.demo) return;
  const allowed = await demoInboxes(db);
  if (!allowed.includes(to.trim().toLowerCase())) {
    throw new AppError("forbidden", "demo mode: email goes only to the seeded demo inbox");
  }
}

export function assertDemoDiscovery(settings: { demo: boolean }, source: string): void {
  if (settings.demo && source !== "fixture") {
    throw new AppError("forbidden", "demo mode: discovery runs only from fixtures");
  }
}
