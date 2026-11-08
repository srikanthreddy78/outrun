import type { CustomElement, Routine } from "@/types";
import { breatheCycleSeconds } from "./breathe";

const ELEMENT_MINUTES: Record<string, number> = {
  greeting:  1,
  weather:   1,
  quote:     1,
  gratitude: 2,
  intention: 2,
  notes:     3,
  exercise:  5,   // overridden by durationSeconds if set
  water:     1,
};

export function estimateMinutes(routine: Routine, customElements: CustomElement[]): number {
  let total = 0;

  for (const el of routine.elements) {
    if (el.type === "breathe") {
      // Real time for the breathing cycles, by pattern, rounded up to a minute.
      const seconds = (el.settings?.cycles ?? 3) * breatheCycleSeconds(el.settings?.pattern);
      total += Math.max(1, Math.ceil(seconds / 60));
    } else if (el.type === "exercise") {
      total += el.settings?.durationSeconds
        ? Math.ceil(el.settings.durationSeconds / 60)
        : 5;
    } else if (el.type === "custom") {
      const def = customElements.find((c) => c.id === el.customElementId);
      if (!def) continue;
      if (def.type === "timer") {
        total += def.settings?.durationSeconds
          ? Math.ceil(def.settings.durationSeconds / 60)
          : 2;
      } else if (def.type === "prompt") {
        total += 2;
      } else {
        total += 1;
      }
    } else {
      total += ELEMENT_MINUTES[el.type] ?? 1;
    }
  }

  return Math.max(total, 1);
}
