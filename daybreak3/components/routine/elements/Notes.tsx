"use client";

import { useState, useRef } from "react";
import { storage } from "@/lib/storage";
import { Button } from "@/components/ui/Button";

type Note = { text: string; addedAt: string };

interface NotesProps {
  onNext: () => void;
  onSkip: () => void;
  notes?: Note[];
  elementId: string;
  routineId: string;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const MAX_VISIBLE = 3;

export function Notes({ onNext, notes, elementId, routineId }: NotesProps) {
  const [notesList, setNotesList] = useState<Note[]>(notes ?? []);
  const [inputText, setInputText] = useState("");
  const [showAll, setShowAll] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const hiddenCount = notesList.length > MAX_VISIBLE ? notesList.length - MAX_VISIBLE : 0;
  const collapsed = !showAll && hiddenCount > 0;
  const visibleNotes = collapsed ? notesList.slice(-MAX_VISIBLE) : notesList;

  const save = (updated: Note[]) => {
    const routine = storage.getRoutine(routineId);
    if (!routine) return;
    const elements = routine.elements.map((e) =>
      e.id === elementId ? { ...e, settings: { ...e.settings, notes: updated } } : e
    );
    storage.updateRoutine(routineId, { elements });
  };

  const addNote = () => {
    const trimmed = inputText.trim();
    if (!trimmed) return;
    const updated = [...notesList, { text: trimmed, addedAt: new Date().toISOString() }];
    setNotesList(updated);
    setInputText("");
    save(updated);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const deleteNote = (realIndex: number) => {
    const updated = notesList.filter((_, i) => i !== realIndex);
    setNotesList(updated);
    save(updated);
  };

  return (
    <div className="flex flex-col items-center justify-start min-h-full pt-[28vh] px-8 gap-10 w-full">
      <p className="text-[11px] font-[Inter] font-medium uppercase tracking-[0.24em] text-[#4A3728]/70">
        Notes to self
      </p>

      <div className="flex flex-col gap-5 w-full max-w-xs">
        {notesList.length > 0 && (
          <div className="flex flex-col gap-3">
            {collapsed && (
              <button
                onClick={() => setShowAll(true)}
                className="text-[#4A3728] text-xs font-[Inter] opacity-35 hover:opacity-60 transition-opacity text-left"
              >
                · {hiddenCount} older
              </button>
            )}

            {visibleNotes.map((note, i) => {
              const realIndex = collapsed ? notesList.length - MAX_VISIBLE + i : i;
              return (
                <div key={realIndex} className="group flex items-baseline gap-2">
                  <span className="text-[#4A3728] opacity-40 text-xs shrink-0">•</span>
                  <p
                    className="flex-1 text-base text-[#2A1F18] leading-snug"
                    style={{ fontFamily: "var(--font-fraunces), Georgia, serif", fontWeight: 400 }}
                  >
                    {note.text}
                    <span className="text-xs font-[Inter] opacity-35 ml-1.5">
                      ({formatDate(note.addedAt)})
                    </span>
                  </p>
                  <button
                    onClick={() => deleteNote(realIndex)}
                    className="text-[#4A3728] text-base opacity-0 group-hover:opacity-50 hover:!opacity-90 transition-opacity shrink-0 leading-none"
                    aria-label="Remove note"
                  >
                    ×
                  </button>
                </div>
              );
            })}

            {showAll && hiddenCount > 0 && (
              <button
                onClick={() => setShowAll(false)}
                className="text-[#4A3728] text-xs font-[Inter] opacity-35 hover:opacity-60 transition-opacity text-left"
              >
                · show less
              </button>
            )}
          </div>
        )}

        <input
          ref={inputRef}
          type="text"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              addNote();
            }
          }}
          placeholder="add a note..."
          autoCapitalize="sentences"
          autoComplete="off" name="db-notes"
          spellCheck
          className="w-full bg-transparent text-[#2A1F18] text-sm font-[Inter] font-light border-b border-[#2A1F18]/20 pb-2 pt-1 focus:outline-none placeholder:text-[#4A3728]/30"
        />
      </div>

      <div className="flex flex-col items-center gap-4">
        <Button onClick={onNext}>Continue</Button>
      </div>
    </div>
  );
}
