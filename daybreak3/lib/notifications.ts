import type { WeekSchedule, WeekDay } from "@/types";

// Morning notification layer.
//
// This template is web-only, so these are intentionally inert stubs: permission
// is never granted and nothing is scheduled. The exports are kept so the
// schedule UI and call sites work unchanged — swap in a real implementation
// (Web Push, or a native local-notifications plugin) to deliver reminders.

export async function requestNotificationPermission(): Promise<boolean> {
  return false;
}

export async function checkNotificationPermission(): Promise<boolean> {
  return false;
}

export async function scheduleNotificationsFromSchedule(
  schedule: WeekSchedule,
  times: Partial<Record<WeekDay, string>>,
  name: string
): Promise<void> {
  void schedule;
  void times;
  void name;
}

export async function cancelMorningNotifications(): Promise<void> {}

export async function fireTestNotification(): Promise<void> {}

export async function getPendingCount(): Promise<number> {
  return 0;
}
