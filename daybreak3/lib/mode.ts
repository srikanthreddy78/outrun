import { storage } from "./storage";
import { getTodayKey } from "./time";

export type AppMode = "routine" | "ambient" | "settings";

export function getMode(): AppMode {
  const settings = storage.getSettings();
  if (!settings.userName) return "settings";

  if (storage.getLastCompletedDate() === getTodayKey()) return "ambient";

  return "routine";
}
