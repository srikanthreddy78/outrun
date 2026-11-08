import type { CustomElement, DayKey, Routine, RoutineElement, Settings, StorageShape, WeatherData, WeekDay, WeekSchedule } from "@/types";
import { createDefaultRoutine } from "./routine-defaults";

const KEY = "daybreak";

function genId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2, 11) + Date.now().toString(36);
}

function getDefaultState(): StorageShape {
  const id = genId();
  return {
    settings: { userName: "", location: null },
    routines: [createDefaultRoutine(id, "My Morning")],
    activeRoutineId: id,
    journalEntries: {},
    gratitudeEntries: {},
    intentions: {},
    lastCompletedDate: null,
    completedDates: [],
    cachedWeather: null,
    weekSchedule: {},
    scheduleTimes: {},
    customElements: [],
    customElementEntries: {},
    installBannerSeen: false,
    tourSeen: false,
    intentionReflections: {},
    lastWeeklyWrapShown: null,
    notificationPromptSeen: false,
    lastReviewRequestCount: 0,
  };
}

function read(): StorageShape {
  if (typeof window === "undefined") return getDefaultState();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) {
      const state = getDefaultState();
      write(state);
      return state;
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // Migration: old shape had `routine` (single object) + `routineVersion` instead of `routines` array
    if (!Array.isArray(parsed.routines)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const existingElements: RoutineElement[] = (parsed as any).routine?.elements ?? [];
      const id = genId();
      const migratedRoutine: Routine = {
        id,
        name: "My Morning",
        elements: existingElements.length > 0
          ? existingElements
          : createDefaultRoutine(id, "My Morning").elements,
        createdAt: new Date().toISOString(),
      };
      const migrated: StorageShape = {
        settings: (parsed.settings as Settings) ?? { userName: "", location: null },
        routines: [migratedRoutine],
        activeRoutineId: id,
        journalEntries: (parsed.journalEntries as Record<DayKey, string>) ?? {},
        gratitudeEntries: (parsed.gratitudeEntries as Record<DayKey, string>) ?? {},
        intentions: (parsed.intentions as Record<DayKey, string>) ?? {},
        lastCompletedDate: (parsed.lastCompletedDate as DayKey | null) ?? null,
        completedDates: (parsed.completedDates as DayKey[]) ?? [],
        cachedWeather: (parsed.cachedWeather as StorageShape["cachedWeather"]) ?? null,
        customElements: (parsed.customElements as CustomElement[]) ?? [],
        customElementEntries: (parsed.customElementEntries as Record<string, Record<DayKey, string>>) ?? {},
        weekSchedule: (parsed.weekSchedule as WeekSchedule) ?? {},
        scheduleTimes: {},
        installBannerSeen: (parsed.installBannerSeen as boolean) ?? false,
        tourSeen: (parsed.tourSeen as boolean) ?? false,
        intentionReflections: (parsed.intentionReflections as Record<string, "yes" | "sort-of" | "pass">) ?? {},
        lastWeeklyWrapShown: (parsed.lastWeeklyWrapShown as string | null) ?? null,
      };
      write(migrated);
      return migrated;
    }

    // Migration: notesText string → notes array
    let notesMigrated = false;
    if (Array.isArray(parsed.routines)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (parsed.routines as any[]).forEach((r) => {
        if (Array.isArray(r.elements)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          r.elements.forEach((e: any) => {
            if (e.settings?.notesText !== undefined) {
              notesMigrated = true;
              const { notesText, ...rest } = e.settings;
              e.settings = {
                ...rest,
                ...(notesText ? { notes: [{ text: notesText, addedAt: new Date().toISOString() }] } : {}),
              };
            }
          });
        }
      });
      if (notesMigrated) write(parsed as unknown as StorageShape);
    }

    // Migration: stretches → exercise
    let stretchesMigrated = false;
    if (Array.isArray(parsed.routines)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (parsed.routines as any[]).forEach((r) => {
        if (Array.isArray(r.elements)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          r.elements.forEach((e: any) => {
            if (e.type === "stretches") {
              stretchesMigrated = true;
              e.type = "exercise";
              e.settings = { durationSeconds: e.settings?.durationSeconds ?? 300 };
            }
          });
        }
      });
      if (stretchesMigrated) write(parsed as unknown as StorageShape);
    }

    // Migration: reflection custom elements → prompt
    let reflectionMigrated = false;
    if (Array.isArray(parsed.customElements)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (parsed.customElements as any[]).forEach((c: any) => {
        if (c.type === "reflection") {
          reflectionMigrated = true;
          c.type = "prompt";
        }
      });
      if (reflectionMigrated) write(parsed as unknown as StorageShape);
    }

    return { ...getDefaultState(), ...parsed };
  } catch {
    return getDefaultState();
  }
}

function write(data: StorageShape): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    // private browsing or storage full — fail silently
  }
}

export const storage = {
  getSettings: (): Settings => read().settings,
  setSettings: (patch: Partial<Settings>): void => {
    const state = read();
    write({ ...state, settings: { ...state.settings, ...patch } });
  },

  getRoutines: (): Routine[] => read().routines ?? [],
  getRoutine: (id: string): Routine | undefined => read().routines.find((r) => r.id === id),
  getActiveRoutineId: (): string => read().activeRoutineId,
  setActiveRoutineId: (id: string): void => {
    const state = read();
    write({ ...state, activeRoutineId: id });
  },
  createRoutine: (name: string): Routine => {
    const state = read();
    const id = genId();
    const routine: Routine = {
      id,
      name,
      elements: [{ id: genId(), type: "greeting" }],
      createdAt: new Date().toISOString(),
    };
    write({ ...state, routines: [...state.routines, routine] });
    return routine;
  },
  updateRoutine: (id: string, updates: Partial<Pick<Routine, "name" | "elements">>): void => {
    const state = read();
    write({
      ...state,
      routines: state.routines.map((r) => (r.id === id ? { ...r, ...updates } : r)),
    });
  },
  deleteRoutine: (id: string): boolean => {
    const state = read();
    if (state.routines.length <= 1) return false;
    const newRoutines = state.routines.filter((r) => r.id !== id);
    const newActiveId = state.activeRoutineId === id ? newRoutines[0].id : state.activeRoutineId;
    const newSchedule = { ...state.weekSchedule };
    for (const day of Object.keys(newSchedule) as WeekDay[]) {
      if (newSchedule[day] === id) delete newSchedule[day];
    }
    write({ ...state, routines: newRoutines, activeRoutineId: newActiveId, weekSchedule: newSchedule });
    return true;
  },
  duplicateRoutine: (id: string): Routine | null => {
    const state = read();
    const source = state.routines.find((r) => r.id === id);
    if (!source) return null;
    const newId = genId();
    const copy: Routine = {
      id: newId,
      name: `${source.name} (copy)`,
      elements: source.elements.map((el) => ({ ...el, id: genId() })),
      createdAt: new Date().toISOString(),
    };
    const sourceIdx = state.routines.findIndex((r) => r.id === id);
    const newRoutines = [
      ...state.routines.slice(0, sourceIdx + 1),
      copy,
      ...state.routines.slice(sourceIdx + 1),
    ];
    write({ ...state, routines: newRoutines });
    return copy;
  },

  getJournalEntry: (date: DayKey): string => read().journalEntries[date] ?? "",
  setJournalEntry: (date: DayKey, text: string): void => {
    const state = read();
    write({ ...state, journalEntries: { ...state.journalEntries, [date]: text } });
  },

  getGratitudeEntry: (date: DayKey): string => read().gratitudeEntries[date] ?? "",
  setGratitudeEntry: (date: DayKey, text: string): void => {
    const state = read();
    write({ ...state, gratitudeEntries: { ...state.gratitudeEntries, [date]: text } });
  },

  getIntention: (date: DayKey): string => read().intentions[date] ?? "",
  setIntention: (date: DayKey, text: string): void => {
    const state = read();
    write({ ...state, intentions: { ...state.intentions, [date]: text } });
  },

  getLastCompletedDate: (): DayKey | null => read().lastCompletedDate,
  setLastCompletedDate: (date: DayKey): void => {
    const state = read();
    const existing = state.completedDates ?? [];
    const completedDates = existing.includes(date) ? existing : [...existing, date];
    write({ ...state, lastCompletedDate: date, completedDates });
  },
  getCompletedDates: (): DayKey[] => read().completedDates ?? [],

  getCachedWeather: (): StorageShape["cachedWeather"] => read().cachedWeather,
  setCachedWeather: (date: DayKey, data: WeatherData): void => {
    const state = read();
    write({ ...state, cachedWeather: { date, data } });
  },

  getCustomElements: (): CustomElement[] => read().customElements ?? [],
  setCustomElements: (customElements: CustomElement[]): void => {
    const state = read();
    write({ ...state, customElements });
  },

  getCustomElementEntry: (elementId: string, date: DayKey): string =>
    read().customElementEntries[elementId]?.[date] ?? "",
  setCustomElementEntry: (elementId: string, date: DayKey, text: string): void => {
    const state = read();
    const existing = state.customElementEntries[elementId] ?? {};
    write({
      ...state,
      customElementEntries: {
        ...state.customElementEntries,
        [elementId]: { ...existing, [date]: text },
      },
    });
  },

  deleteCustomElement: (id: string): void => {
    const state = read();
    const customElements = state.customElements.filter((c) => c.id !== id);
    const routines = state.routines.map((r) => ({
      ...r,
      elements: r.elements.filter((e) => !(e.type === "custom" && e.customElementId === id)),
    }));
    const customElementEntries = { ...state.customElementEntries };
    delete customElementEntries[id];
    write({ ...state, customElements, routines, customElementEntries });
  },

  getWeekSchedule: (): WeekSchedule => read().weekSchedule ?? {},
  setDaySchedule: (day: WeekDay, routineId: string | null): void => {
    const state = read();
    const schedule = { ...(state.weekSchedule ?? {}) };
    if (routineId === null) {
      delete schedule[day];
    } else {
      schedule[day] = routineId;
    }
    write({ ...state, weekSchedule: schedule });
  },

  getScheduleTimes: (): Partial<Record<WeekDay, string>> => read().scheduleTimes ?? {},
  setScheduleTime: (day: WeekDay, time: string): void => {
    const state = read();
    write({ ...state, scheduleTimes: { ...(state.scheduleTimes ?? {}), [day]: time } });
  },

  getLastReviewRequestCount: (): number => read().lastReviewRequestCount ?? 0,
  setLastReviewRequestCount: (count: number): void => {
    const state = read();
    write({ ...state, lastReviewRequestCount: count });
  },

  getInstallBannerSeen: (): boolean => read().installBannerSeen ?? false,
  setInstallBannerSeen: (): void => {
    const state = read();
    write({ ...state, installBannerSeen: true });
  },

  getTourSeen: (): boolean => read().tourSeen ?? false,
  setTourSeen: (): void => {
    const state = read();
    write({ ...state, tourSeen: true });
  },

  getNotificationPromptSeen: (): boolean => read().notificationPromptSeen ?? false,
  setNotificationPromptSeen: (): void => {
    const state = read();
    write({ ...state, notificationPromptSeen: true });
  },
  resetTourSeen: (): void => {
    const state = read();
    write({ ...state, tourSeen: false });
  },

  getIntentionReflection: (date: DayKey): "yes" | "sort-of" | "pass" | null =>
    read().intentionReflections?.[date] ?? null,
  setIntentionReflection: (date: DayKey, value: "yes" | "sort-of" | "pass"): void => {
    const state = read();
    write({ ...state, intentionReflections: { ...(state.intentionReflections ?? {}), [date]: value } });
  },

  getLastWeeklyWrapShown: (): DayKey | null => read().lastWeeklyWrapShown ?? null,
  setLastWeeklyWrapShown: (date: DayKey): void => {
    const state = read();
    write({ ...state, lastWeeklyWrapShown: date });
  },

  clearAll: (): void => {
    if (typeof window === "undefined") return;
    try {
      localStorage.removeItem(KEY);
    } catch {
      // ignore
    }
  },
};
