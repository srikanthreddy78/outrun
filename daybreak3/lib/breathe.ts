import type { BreathePatternId } from "@/types";

// Breathing patterns selectable per breathe element. Phase durations in ms.
// A `hold` of 0 means the pattern skips the hold beat entirely (even breathing).
export const BREATHE_PATTERNS: Record<
  BreathePatternId,
  { label: string; hint: string; inhale: number; hold: number; exhale: number }
> = {
  calm: { label: "calm", hint: "3 · 1.5 · 4", inhale: 3000, hold: 1500, exhale: 4000 },
  "478": { label: "4-7-8", hint: "4 · 7 · 8", inhale: 4000, hold: 7000, exhale: 8000 },
  even: { label: "even", hint: "4 · 4", inhale: 4000, hold: 0, exhale: 4000 },
};

export const DEFAULT_BREATHE_PATTERN: BreathePatternId = "calm";

export function breathePattern(id: BreathePatternId | undefined) {
  return BREATHE_PATTERNS[id ?? DEFAULT_BREATHE_PATTERN];
}

// Seconds for one full cycle of a pattern (used for duration estimates).
export function breatheCycleSeconds(id: BreathePatternId | undefined): number {
  const p = breathePattern(id);
  return (p.inhale + p.hold + p.exhale) / 1000;
}
