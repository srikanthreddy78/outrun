"use client";

import type { CustomElement } from "@/types";

function formatDuration(s: number): string {
  if (s < 60) return `${s}s`;
  const m = s / 60;
  return Number.isInteger(m) ? `${m}m` : `${Math.round(m)}m`;
}

function typeTag(el: CustomElement): string {
  if (el.type === "timer") {
    const d = el.settings?.durationSeconds ?? 60;
    return `timer · ${formatDuration(d)}`;
  }
  return el.type as string;
}

interface CustomElementListProps {
  customElements: CustomElement[];
  onAdd: (customElementId: string) => void;
  onEdit: (id: string) => void;
  onCreateNew: () => void;
}

export function CustomElementList({ customElements, onAdd, onEdit, onCreateNew }: CustomElementListProps) {
  return (
    <div className="flex flex-col gap-3">
      {/* Create button */}
      <button
        onClick={onCreateNew}
        className="flex items-center gap-3 px-5 py-3.5 rounded-2xl border border-dashed border-[#2A1F18]/20 text-[#4A3728] text-sm font-[Inter] opacity-60 hover:opacity-90 transition-opacity w-full text-left"
      >
        <span className="text-base leading-none opacity-70">+</span>
        Create Custom
      </button>

      {/* Empty state */}
      {customElements.length === 0 && (
        <p className="text-[#4A3728] text-xs font-[Inter] opacity-40 text-center py-2">
          no custom elements yet
        </p>
      )}

      {/* List */}
      {customElements.map((el) => (
        <div
          key={el.id}
          className="group flex items-stretch rounded-2xl bg-[#2A1F18]/[0.03] border border-[#2A1F18]/10 overflow-hidden hover:bg-[#2A1F18]/[0.07] transition-colors"
        >
          <button
            onClick={() => onAdd(el.id)}
            className="flex-1 flex items-center gap-4 px-5 py-4 text-left"
          >
            <div className="flex-1 min-w-0">
              <p className="text-[#2A1F18] text-sm font-[Inter] font-medium leading-tight truncate">
                {el.label}{el.emoji && <span className="ml-1">{el.emoji}</span>}
              </p>
              <p className="text-[#4A3728] text-xs font-[Inter] font-light mt-0.5 leading-tight opacity-60">
                {typeTag(el)}
              </p>
            </div>
            <span className="text-[#4A3728] text-lg opacity-40 shrink-0 leading-none">+</span>
          </button>
          <div className="w-px bg-[#2A1F18]/[0.06] shrink-0" />
          <button
            onClick={() => onEdit(el.id)}
            className="px-4 text-[#4A3728] text-sm font-[Inter] opacity-25 hover:opacity-60 transition-opacity shrink-0"
            aria-label={`Edit ${el.label}`}
          >
            ···
          </button>
        </div>
      ))}
    </div>
  );
}
