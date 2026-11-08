"use client";

import { AnimatePresence, motion } from "framer-motion";
import { ELEMENT_META } from "@/lib/element-meta";
import { BREATHE_PATTERNS } from "@/lib/breathe";
import type { BreathePatternId, CustomElement, ElementType, RoutineElement } from "@/types";
import { ElementSettings } from "./ElementSettings";

interface ElementCardProps {
  element: RoutineElement;
  customEl?: CustomElement;
  isExpanded: boolean;
  canRemove: boolean;
  onToggleSettings: () => void;
  onRemove: () => void;
  onChange: (updated: RoutineElement) => void;
}

function formatDuration(s: number): string {
  if (s < 60) return `${s}s`;
  const m = s / 60;
  return Number.isInteger(m) ? `${m}m` : `${Math.round(m)}m`;
}

function customTypeTag(el: CustomElement): string {
  if (el.type === "timer") return `timer · ${formatDuration(el.settings?.durationSeconds ?? 60)}`;
  return el.type as string;
}

// Short current-value summary for a built-in's settings — shown on the card so
// the current setting is visible at a glance and the card reads as adjustable.
function settingsSummary(element: RoutineElement): string | null {
  if (element.type === "breathe") {
    const cycles = element.settings?.cycles ?? 2;
    const p = BREATHE_PATTERNS[(element.settings?.pattern ?? "calm") as BreathePatternId];
    return `${p.label} · ${cycles}×`;
  }
  if (element.type === "exercise") {
    return formatDuration(element.settings?.durationSeconds ?? 600);
  }
  return null;
}

export function ElementCard({
  element,
  customEl,
  isExpanded,
  canRemove,
  onToggleSettings,
  onRemove,
  onChange,
}: ElementCardProps) {
  const isCustom = element.type === "custom";
  const meta = isCustom ? null : ELEMENT_META[element.type as ElementType];
  const displayName = isCustom ? (customEl?.label ?? "Custom") : meta!.name;
  const displayDesc = isCustom ? (customEl ? customTypeTag(customEl) : "") : meta!.description;
  const hasSettings = isCustom ? false : meta!.hasSettings;
  const emoji = isCustom ? customEl?.emoji : undefined;
  const summary = isCustom ? null : settingsSummary(element);

  return (
    <div className="group rounded-2xl bg-[#2A1F18]/[0.04] border border-[#2A1F18]/10 overflow-hidden hover:bg-[#2A1F18]/[0.07] transition-colors">
      {/* Main row */}
      <div
        className="flex items-center gap-4 px-5 py-4 select-none"
        onClick={hasSettings ? onToggleSettings : undefined}
        style={{ cursor: hasSettings ? "pointer" : "default" }}
      >
        {/* Drag handle — 3×2 dot grid */}
        <div className="flex flex-col gap-[3px] shrink-0 opacity-25 py-px">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex gap-[3px]">
              <div className="w-[3px] h-[3px] rounded-full bg-[#2A1F18]" />
              <div className="w-[3px] h-[3px] rounded-full bg-[#2A1F18]" />
            </div>
          ))}
        </div>

        {/* Name + description */}
        <div className="flex-1 min-w-0">
          <p className="text-[#2A1F18] text-sm font-[Inter] font-medium leading-tight truncate">
            {displayName}{emoji && <span className="ml-1">{emoji}</span>}
          </p>
          <p className="text-[#4A3728] text-xs font-[Inter] font-light mt-0.5 leading-tight opacity-70">
            {displayDesc}
          </p>
        </div>

        {/* Summary + chevron + remove */}
        <div className="flex items-center gap-3 shrink-0">
          {summary && (
            <span className="text-[#4A3728] text-xs font-[Inter] opacity-50">{summary}</span>
          )}
          {hasSettings && (
            <motion.span
              animate={{ rotate: isExpanded ? 180 : 0 }}
              transition={{ duration: 0.2 }}
              className="text-[#4A3728] text-xs opacity-40 leading-none"
            >
              ▾
            </motion.span>
          )}
          {canRemove && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
              className="text-[#4A3728] text-xl opacity-25 hover:opacity-60 transition-opacity leading-none"
              aria-label={`Remove ${displayName}`}
            >
              ×
            </button>
          )}
        </div>
      </div>

      {/* Inline settings panel */}
      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            key="settings"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: "easeInOut" }}
            style={{ overflow: "hidden" }}
          >
            <div className="px-5 pb-4 pt-2 border-t border-[#2A1F18]/[0.06]">
              <ElementSettings
                element={element}
                onChange={(settings) => onChange({ ...element, settings })}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
