"use client";

import { useState } from "react";

interface Preset {
  label: string;
  value: number;
}

interface DurationPickerProps {
  value: number;
  onChange: (seconds: number) => void;
  presets: Preset[];
}

export function DurationPicker({ value, onChange, presets }: DurationPickerProps) {
  const isPresetMatch = presets.some((p) => p.value === value);

  const [activePreset, setActivePreset] = useState<number | null>(
    isPresetMatch ? value : null
  );
  const [minsStr, setMinsStr] = useState(String(Math.floor(value / 60)));
  const [secsStr, setSecsStr] = useState(String(value % 60));

  const totalSeconds =
    Math.max(0, parseInt(minsStr, 10) || 0) * 60 +
    Math.min(59, Math.max(0, parseInt(secsStr, 10) || 0));

  const handlePreset = (preset: Preset) => {
    setActivePreset(preset.value);
    setMinsStr(String(Math.floor(preset.value / 60)));
    setSecsStr(String(preset.value % 60));
    onChange(preset.value);
  };

  const handleMinsChange = (val: string) => {
    setMinsStr(val);
    setActivePreset(null);
    const m = Math.max(0, parseInt(val, 10) || 0);
    const s = Math.min(59, Math.max(0, parseInt(secsStr, 10) || 0));
    onChange(m * 60 + s);
  };

  const handleSecsChange = (val: string) => {
    setSecsStr(val);
    setActivePreset(null);
    const m = Math.max(0, parseInt(minsStr, 10) || 0);
    const s = Math.min(59, Math.max(0, parseInt(val, 10) || 0));
    onChange(m * 60 + s);
  };

  const handleSecsBlur = () => {
    const clamped = Math.min(59, Math.max(0, parseInt(secsStr, 10) || 0));
    setSecsStr(String(clamped));
  };

  const handleMinsBlur = () => {
    const norm = Math.max(0, parseInt(minsStr, 10) || 0);
    setMinsStr(String(norm));
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[#4A3728] text-xs font-[Inter] opacity-60">duration</p>

      {/* Preset chips */}
      <div className="flex flex-wrap gap-2">
        {presets.map((preset) => (
          <button
            key={preset.value}
            type="button"
            onClick={() => handlePreset(preset)}
            className={`px-3 py-1 rounded-full text-xs font-[Inter] transition-colors ${
              activePreset === preset.value
                ? "bg-[#2A1F18]/15 text-[#2A1F18]"
                : "bg-[#2A1F18]/[0.05] text-[#4A3728] hover:bg-[#2A1F18]/10"
            }`}
          >
            {preset.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setActivePreset(null)}
          className={`px-3 py-1 rounded-full text-xs font-[Inter] transition-colors ${
            activePreset === null
              ? "bg-[#2A1F18]/15 text-[#2A1F18]"
              : "bg-[#2A1F18]/[0.05] text-[#4A3728] hover:bg-[#2A1F18]/10"
          }`}
        >
          Custom
        </button>
      </div>

      {/* Freeform min / sec */}
      <div className="flex items-center gap-4">
        <div className="flex items-baseline gap-1.5">
          <input
            type="number"
            value={minsStr}
            onChange={(e) => handleMinsChange(e.target.value)}
            onBlur={handleMinsBlur}
            min={0}
            placeholder="0"
            className="w-11 bg-transparent text-[#2A1F18] font-[Inter] text-sm border-b border-[#2A1F18]/20 pb-1 focus:outline-none text-center placeholder:opacity-30"
          />
          <span className="text-[#4A3728] text-xs font-[Inter] opacity-50">min</span>
        </div>
        <div className="flex items-baseline gap-1.5">
          <input
            type="number"
            value={secsStr}
            onChange={(e) => handleSecsChange(e.target.value)}
            onBlur={handleSecsBlur}
            min={0}
            max={59}
            placeholder="0"
            className="w-11 bg-transparent text-[#2A1F18] font-[Inter] text-sm border-b border-[#2A1F18]/20 pb-1 focus:outline-none text-center placeholder:opacity-30"
          />
          <span className="text-[#4A3728] text-xs font-[Inter] opacity-50">sec</span>
        </div>
        {totalSeconds === 0 && (
          <p className="text-[#4A3728] text-xs font-[Inter] opacity-35">add a duration</p>
        )}
      </div>
    </div>
  );
}
