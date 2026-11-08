"use client";

import type { BreathePatternId, RoutineElement } from "@/types";
import { BREATHE_PATTERNS } from "@/lib/breathe";
import { DurationPicker } from "./DurationPicker";

const EXERCISE_PRESETS = [
  { label: "5 min",  value: 300 },
  { label: "10 min", value: 600 },
  { label: "15 min", value: 900 },
  { label: "30 min", value: 1800 },
  { label: "60 min", value: 3600 },
];

interface Props {
  element: RoutineElement;
  onChange: (settings: RoutineElement["settings"]) => void;
}

export function ElementSettings({ element, onChange }: Props) {
  const s = element.settings ?? {};

  if (element.type === "breathe") {
    const pattern = (s.pattern ?? "calm") as BreathePatternId;
    return (
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <p className="text-[#4A3728] text-xs font-[Inter] opacity-60">pattern</p>
          <div className="flex gap-2 flex-wrap">
            {(Object.keys(BREATHE_PATTERNS) as BreathePatternId[]).map((id) => (
              <button
                key={id}
                onClick={() => onChange({ ...s, pattern: id })}
                className={`px-3 py-1.5 rounded-full text-sm font-[Inter] transition-colors ${
                  pattern === id
                    ? "bg-[#2A1F18]/15 text-[#2A1F18]"
                    : "bg-[#2A1F18]/[0.05] text-[#4A3728] hover:bg-[#2A1F18]/10"
                }`}
              >
                {BREATHE_PATTERNS[id].label}
              </button>
            ))}
          </div>
          <p className="text-[#4A3728] text-xs font-[Inter] opacity-40">
            {BREATHE_PATTERNS[pattern].hint} seconds
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <p className="text-[#4A3728] text-xs font-[Inter] opacity-60">cycles</p>
          <div className="flex gap-2">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                onClick={() => onChange({ ...s, cycles: n })}
                className={`w-9 h-9 rounded-full text-sm font-[Inter] transition-colors ${
                  (s.cycles ?? 2) === n
                    ? "bg-[#2A1F18]/15 text-[#2A1F18]"
                    : "bg-[#2A1F18]/[0.05] text-[#4A3728] hover:bg-[#2A1F18]/10"
                }`}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (element.type === "exercise") {
    return (
      <DurationPicker
        value={s.durationSeconds ?? 600}
        onChange={(v) => onChange({ ...s, durationSeconds: v })}
        presets={EXERCISE_PRESETS}
      />
    );
  }

  if (element.type === "notes") {
    const count = s.notes?.length ?? 0;
    return (
      <div className="flex flex-col gap-1">
        <p className="text-[#4A3728] text-xs font-[Inter] opacity-60">
          {count === 0 ? "no notes yet" : `${count} note${count === 1 ? "" : "s"}`}
        </p>
        <p className="text-[#4A3728] text-xs font-[Inter] opacity-40">
          add and manage notes during your routine
        </p>
      </div>
    );
  }

  return null;
}
