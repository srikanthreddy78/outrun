"use client";

import { ELEMENT_META } from "@/lib/element-meta";
import type { ElementType } from "@/types";

// All built-in types except greeting — greeting is always locked first
const LIBRARY_TYPES: ElementType[] = [
  "weather",
  "quote",
  "breathe",
  "gratitude",
  "intention",
  "notes",
  "exercise",
  "water",
];

interface ElementLibraryProps {
  usedTypes: Set<ElementType>;
  onAdd: (type: ElementType) => void;
}

export function ElementLibrary({ usedTypes, onAdd }: ElementLibraryProps) {
  const available = LIBRARY_TYPES.filter((t) => !usedTypes.has(t));

  if (available.length === 0) {
    return (
      <p className="text-[#4A3728] text-sm font-[Inter] font-light opacity-40 px-1">
        all elements added
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {available.map((type) => {
        const meta = ELEMENT_META[type];
        return (
          <button
            key={type}
            onClick={() => onAdd(type)}
            className="group flex items-center gap-4 px-5 py-4 rounded-2xl border border-[#2A1F18]/10 bg-[#2A1F18]/[0.03] hover:bg-[#2A1F18]/[0.08] transition-colors text-left w-full"
          >
            <div className="flex-1 min-w-0">
              <p className="text-[#2A1F18] text-sm font-[Inter] font-medium leading-tight">
                {meta.name}
              </p>
              <p className="text-[#4A3728] text-xs font-[Inter] font-light mt-0.5 leading-tight">
                {meta.description}
              </p>
            </div>
            <span className="text-[#4A3728] text-lg opacity-40 shrink-0 leading-none">
              +
            </span>
          </button>
        );
      })}
    </div>
  );
}
