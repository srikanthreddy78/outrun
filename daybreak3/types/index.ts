export type WeatherData = {
  temp: number;
  feelsLike: number;
  high: number;
  low: number;
  description: string;
  city: string;
  rainChance: number | null;
  rainTimeLabel: string;
};

export type MorningVibe = "peaceful" | "focused" | "energised" | "present";

export type Settings = {
  userName: string;
  location: { lat: number; lng: number; city: string } | null;
  morningVibe?: MorningVibe;
  soundEnabled?: boolean;
  hapticsEnabled?: boolean;
  notificationTime?: string; // "07:30" 24h
  notificationsEnabled?: boolean; // global master switch; undefined = on
};

export type DayKey = string; // ISO date: "2026-05-05"

export type WeekDay = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export type WeekSchedule = Partial<Record<WeekDay, string>>; // routineId per day; undefined = rest

export type ElementType =
  | "greeting"
  | "weather"
  | "quote"
  | "breathe"
  | "gratitude"
  | "intention"
  | "reflection"
  | "notes"
  | "exercise"
  | "water";

export type CustomElementType = "prompt" | "timer" | "confirm";

export type CustomElement = {
  id: string;
  type: CustomElementType;
  label: string;
  emoji?: string;
  description?: string; // optional sub-line shown under the label during the routine
  settings?: {
    durationSeconds?: number;
  };
  createdAt: string;
};

export type BreathePatternId = "calm" | "478" | "even";

export type RoutineElement = {
  id: string;
  type: ElementType | "custom";
  customElementId?: string;
  settings?: {
    cycles?: number;             // breathe: number of cycles
    pattern?: BreathePatternId;  // breathe: which breathing pattern
    durationSeconds?: number;    // silence, stretches, exercise
    notes?: { text: string; addedAt: string }[];
  };
};

export type Routine = {
  id: string;
  name: string;
  elements: RoutineElement[];
  createdAt: string;
};

export type StorageShape = {
  settings: Settings;
  routines: Routine[];
  activeRoutineId: string;
  journalEntries: Record<DayKey, string>;
  gratitudeEntries: Record<DayKey, string>;
  intentions: Record<DayKey, string>;
  lastCompletedDate: DayKey | null;
  completedDates: DayKey[];
  cachedWeather: { date: DayKey; data: WeatherData } | null;
  customElements: CustomElement[];
  customElementEntries: Record<string, Record<DayKey, string>>;
  weekSchedule: WeekSchedule;
  scheduleTimes: Partial<Record<WeekDay, string>>;
  installBannerSeen: boolean;
  tourSeen: boolean;
  intentionReflections: Record<DayKey, "yes" | "sort-of" | "pass">;
  lastWeeklyWrapShown: DayKey | null;
  notificationPromptSeen?: boolean;
  // Highest completed-morning count at which we've requested an App Store
  // review, so each milestone (2nd, 3rd) only ever asks once.
  lastReviewRequestCount?: number;
};
