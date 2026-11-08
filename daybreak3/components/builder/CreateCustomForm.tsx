"use client";

import { useState, useRef, useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { CustomElement, CustomElementType } from "@/types";
import { DurationPicker } from "./DurationPicker";

const CUSTOM_TYPES: CustomElementType[] = ["prompt", "timer", "confirm"];

const TYPE_LABELS: Record<CustomElementType, string> = {
  prompt:  "Prompt",
  timer:   "Timer",
  confirm: "Confirm",
};

const TYPE_DESCRIPTIONS: Record<CustomElementType, string> = {
  prompt:  "with a note",
  timer:   "with a timer",
  confirm: "check it off",
};

const TIMER_PRESETS = [
  { label: "30s",  value: 30 },
  { label: "1 min",  value: 60 },
  { label: "2 min",  value: 120 },
  { label: "5 min",  value: 300 },
  { label: "10 min", value: 600 },
  { label: "15 min", value: 900 },
  { label: "30 min", value: 1800 },
];

const EMOJI_LIST = [
  "🌅", "🌞", "🌿", "🌸", "☁️", "🌙",
  "☕", "🍳", "🥗", "🥤", "💧", "🍎", "🧃", "🫖",
  "🏋️", "🧘", "🏃", "🚶", "🤸", "🧗", "🚴",
  "💊", "🪥", "🚿", "❄️", "🛁", "💤",
  "📖", "✍️", "📝", "🎯", "🧠", "🎵", "🎒",
  "🙏", "🫁", "💛", "✨", "🕯️", "🫶",
];

function SmileFaceIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="7.5" cy="7.5" r="6" stroke="currentColor" strokeWidth="1.1" />
      <circle cx="5.2" cy="6" r="0.65" fill="currentColor" />
      <circle cx="9.8" cy="6" r="0.65" fill="currentColor" />
      <path d="M5 9 Q7.5 11 10 9" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" fill="none" />
    </svg>
  );
}

interface CreateCustomFormProps {
  mode: "create" | "edit";
  initialValues?: Pick<CustomElement, "type" | "label" | "emoji" | "description" | "settings">;
  onSave: (values: Pick<CustomElement, "type" | "label" | "emoji" | "description" | "settings">) => void;
  onCancel: () => void;
  onDelete?: () => void;
}

export function CreateCustomForm({ mode, initialValues, onSave, onCancel, onDelete }: CreateCustomFormProps) {
  const [type, setType] = useState<CustomElementType>(initialValues?.type ?? "prompt");
  const [label, setLabel] = useState(initialValues?.label ?? "");
  const [emoji, setEmoji] = useState(initialValues?.emoji ?? "");
  const [description, setDescription] = useState(initialValues?.description ?? "");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [durationSeconds, setDurationSeconds] = useState(initialValues?.settings?.durationSeconds ?? 60);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pickerOpen) return;
    function onMouseDown(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [pickerOpen]);

  const handleTypeChange = (t: CustomElementType) => {
    setType(t);
    if (t !== "timer") setDurationSeconds(60);
  };

  const handleSave = () => {
    if (!label.trim()) return;
    const settings = type === "timer" ? { durationSeconds } : undefined;
    // Sub-text only applies to the text-y types (prompt/confirm), not timers.
    const desc = type !== "timer" && description.trim() ? description.trim() : undefined;
    onSave({ type, label: label.trim(), emoji: emoji || undefined, description: desc, settings });
  };

  return (
    <div className="flex flex-col gap-5 rounded-2xl bg-[#2A1F18]/[0.04] border border-[#2A1F18]/10 p-5">
      {/* Type chips */}
      <div className="flex flex-col gap-2">
        <div className="flex gap-2 flex-wrap">
          {CUSTOM_TYPES.map((t) => (
            <button
              key={t}
              onClick={() => handleTypeChange(t)}
              className={`px-4 py-1.5 text-sm font-[Inter] rounded-full transition-colors ${
                type === t
                  ? "bg-[#2A1F18]/15 text-[#2A1F18]"
                  : "bg-[#2A1F18]/[0.05] text-[#4A3728] hover:bg-[#2A1F18]/10"
              }`}
            >
              {TYPE_LABELS[t]}
            </button>
          ))}
        </div>
        <p className="text-[#4A3728] text-xs font-[Inter] opacity-50">{TYPE_DESCRIPTIONS[type]}</p>
      </div>

      {/* Label row + emoji picker */}
      <div ref={pickerRef} className="flex flex-col gap-2">
        <div className="flex items-end gap-3">
          {/* Emoji trigger */}
          <button
            type="button"
            onClick={() => setPickerOpen((o) => !o)}
            className="shrink-0 w-7 h-7 flex items-center justify-center text-[#4A3728] opacity-30 hover:opacity-60 transition-opacity mb-1"
            aria-label="Pick emoji"
          >
            {emoji ? (
              <span className="text-base leading-none">{emoji}</span>
            ) : (
              <SmileFaceIcon />
            )}
          </button>

          {/* Label input */}
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSave()}
            placeholder="what's this called?"
            autoCapitalize="sentences"
            autoComplete="off"
            spellCheck
            className="flex-1 bg-transparent text-[#2A1F18] font-[Inter] text-sm border-b border-[#2A1F18]/20 pb-2 pt-1 focus:outline-none placeholder:text-[#4A3728]/40"
          />

          {/* Clear emoji */}
          {emoji && (
            <button
              type="button"
              onClick={() => setEmoji("")}
              className="shrink-0 text-[#4A3728] text-sm opacity-25 hover:opacity-60 transition-opacity mb-1 leading-none"
              aria-label="Remove emoji"
            >
              ×
            </button>
          )}
        </div>

        {/* Inline emoji picker */}
        <AnimatePresence>
          {pickerOpen && (
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              className="rounded-xl bg-[#2A1F18]/[0.05] border border-[#2A1F18]/[0.08] p-2"
            >
              <div className="grid grid-cols-6 gap-0.5">
                {EMOJI_LIST.map((em) => (
                  <button
                    key={em}
                    type="button"
                    onClick={() => { setEmoji(em); setPickerOpen(false); }}
                    className={`flex items-center justify-center h-11 rounded-lg text-[1.6rem] transition-colors ${
                      emoji === em
                        ? "bg-[#2A1F18]/[0.12]"
                        : "hover:bg-[#2A1F18]/[0.06]"
                    }`}
                    aria-label={em}
                  >
                    {em}
                  </button>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Optional sub-text — prompt / confirm only */}
      {type !== "timer" && (
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="add a hint (optional)"
          autoCapitalize="sentences"
          autoComplete="off"
          spellCheck
          className="bg-transparent text-[#4A3728] font-[Inter] text-sm border-b border-[#2A1F18]/15 pb-2 pt-1 focus:outline-none placeholder:text-[#4A3728]/40"
        />
      )}

      {/* Duration picker — timer only */}
      {type === "timer" && (
        <DurationPicker
          value={durationSeconds}
          onChange={setDurationSeconds}
          presets={TIMER_PRESETS}
        />
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-4 pt-1">
        <button
          onClick={handleSave}
          disabled={!label.trim()}
          className="text-[#2A1F18] text-sm font-[Inter] font-medium opacity-80 hover:opacity-100 transition-opacity disabled:opacity-25 disabled:cursor-default"
        >
          {mode === "create" ? "Add" : "Save"}
        </button>
        <button
          onClick={onCancel}
          className="text-[#4A3728] text-sm font-[Inter] opacity-40 hover:opacity-70 transition-opacity"
        >
          cancel
        </button>
      </div>

      {/* Delete (edit mode only) */}
      {mode === "edit" && onDelete && (
        <div className="border-t border-[#2A1F18]/[0.06] pt-3">
          {!confirmDelete ? (
            <button
              onClick={() => setConfirmDelete(true)}
              className="text-[#4A3728] text-xs font-[Inter] opacity-30 hover:opacity-60 transition-opacity"
            >
              Delete this element
            </button>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-[#4A3728] text-xs font-[Inter] opacity-60">
                Delete &ldquo;{label || "this element"}&rdquo;? This will also remove it from your routine.
              </p>
              <div className="flex gap-4">
                <button
                  onClick={onDelete}
                  className="text-red-400/70 text-xs font-[Inter] hover:text-red-400 transition-colors"
                >
                  Delete
                </button>
                <button
                  onClick={() => setConfirmDelete(false)}
                  className="text-[#4A3728] text-xs font-[Inter] opacity-40 hover:opacity-70 transition-opacity"
                >
                  nevermind
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
