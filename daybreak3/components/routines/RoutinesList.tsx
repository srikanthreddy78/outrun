"use client";

import { useState, useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { useRouter } from "next/navigation";
import { storage } from "@/lib/storage";
import { ELEMENT_META } from "@/lib/element-meta";
import { fraunces, Rule } from "@/components/ui/kit";
import type { CustomElement, ElementType, Routine } from "@/types";

interface RoutinesListProps {
  onOpen: (id: string) => void;
  embedded?: boolean;
}

export function RoutinesList({ onOpen, embedded = false }: RoutinesListProps) {
  const router = useRouter();
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [customElements, setCustomElements] = useState<CustomElement[]>([]);
  const [activeRoutineId, setActiveRoutineId] = useState("");
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [showNewForm, setShowNewForm] = useState(false);
  const [newName, setNewName] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setRoutines(storage.getRoutines());
    setActiveRoutineId(storage.getActiveRoutineId());
    setCustomElements(storage.getCustomElements());
  }, []);

  useEffect(() => {
    if (renamingId) renameInputRef.current?.focus();
  }, [renamingId]);

  function refresh() {
    setRoutines(storage.getRoutines());
    setActiveRoutineId(storage.getActiveRoutineId());
    setCustomElements(storage.getCustomElements());
  }

  function getElementPreview(routine: Routine): string {
    const MAX = 4;
    const names = routine.elements.slice(0, MAX + 1).map((el) => {
      if (el.type === "custom") {
        const found = customElements.find((c) => c.id === el.customElementId);
        return found?.label ?? "custom";
      }
      return ELEMENT_META[el.type as ElementType]?.name ?? el.type;
    });
    if (names.length > MAX) {
      return names.slice(0, MAX).join(" · ") + " · …";
    }
    return names.join(" · ");
  }

  function resetMenuState() {
    setOpenMenuId(null);
    setRenamingId(null);
    setDeleteConfirmId(null);
  }

  const handleSetActive = (id: string) => {
    storage.setActiveRoutineId(id);
    setActiveRoutineId(id);
    setOpenMenuId(null);
  };

  const handleDuplicate = (id: string) => {
    storage.duplicateRoutine(id);
    refresh();
    setOpenMenuId(null);
  };

  const startRename = (id: string, currentName: string) => {
    resetMenuState();
    setRenamingId(id);
    setRenameValue(currentName);
  };

  const commitRename = (id: string) => {
    const trimmed = renameValue.trim();
    if (trimmed) storage.updateRoutine(id, { name: trimmed });
    refresh();
    setRenamingId(null);
  };

  const startDelete = (id: string) => {
    setOpenMenuId(null);
    setDeleteConfirmId(id);
  };

  const confirmDelete = (id: string) => {
    storage.deleteRoutine(id);
    refresh();
    setDeleteConfirmId(null);
  };

  const handleCreateNew = () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    const routine = storage.createRoutine(trimmed);
    storage.setActiveRoutineId(routine.id);
    setActiveRoutineId(routine.id);
    setShowNewForm(false);
    setNewName("");
    onOpen(routine.id);
  };

  const wrap = (children: React.ReactNode) =>
    embedded ? (
      <div className="w-full px-6 pb-32 flex flex-col gap-8" style={{ paddingTop: "calc(env(safe-area-inset-top) + 2.5rem)" }}>{children}</div>
    ) : (
      <main className="dawn-gradient min-h-screen w-full flex items-stretch justify-center">
        <div className="w-full max-w-[600px] mx-auto px-6 pt-14 pb-24 flex flex-col gap-8">{children}</div>
      </main>
    );

  if (routines.length === 0) {
    return (
      wrap(<>
        <p className="text-[#4A3728] text-sm font-[Inter] opacity-50">No routines yet.</p>
        <button
          onClick={() => { const r = storage.createRoutine("My Morning"); storage.setActiveRoutineId(r.id); onOpen(r.id); }}
          className="text-[#4A3728] text-sm font-[Inter] opacity-60 hover:opacity-90 transition-opacity self-start"
        >
          + Create a routine
        </button>
      </>)
    );
  }

  return (
    wrap(<>
      <div className="flex flex-col gap-8">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: "easeOut" }}
          className="flex flex-col gap-8"
        >
          {/* Header */}
          {!embedded && (
            <div className="flex items-center justify-between">
              <button
                onClick={() => router.push("/")}
                className="text-[#4A3728] text-sm font-[Inter] opacity-60 hover:opacity-100 transition-opacity"
              >
                ← back
              </button>
            </div>
          )}

          <div className="flex flex-col gap-5">
            <h1
              className="text-[40px] leading-[1.0] text-[#2A1F18]"
              style={fraunces(300)}
            >
              Your Routines.
            </h1>
            <Rule />
          </div>

          {/* Routine list — Open-style hairline rows */}
          <div className="flex flex-col">
            {[...routines].sort((a, b) => (a.id === activeRoutineId ? -1 : b.id === activeRoutineId ? 1 : 0)).map((routine, idx, arr) => {
              const isActive = routine.id === activeRoutineId;
              const isMenuOpen = openMenuId === routine.id;
              const isRenaming = renamingId === routine.id;
              const isDeleteConfirm = deleteConfirmId === routine.id;
              const isOnlyRoutine = routines.length === 1;

              return (
                <div key={routine.id} className="flex flex-col">
                  {/* Main row */}
                  <div className="flex items-center gap-3 py-4">
                    <button
                      onClick={() => onOpen(routine.id)}
                      className="flex-1 text-left min-w-0"
                    >
                      {isRenaming ? (
                        <input
                          ref={renameInputRef}
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onBlur={() => commitRename(routine.id)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitRename(routine.id);
                            if (e.key === "Escape") { setRenamingId(null); setRenameValue(""); }
                          }}
                          onClick={(e) => e.stopPropagation()}
                          className="text-[22px] text-[#2A1F18] bg-transparent border-b border-[#2A1F18]/20 pb-0.5 focus:outline-none w-full"
                          style={fraunces(300)}
                        />
                      ) : (
                        <p
                          className="text-[22px] text-[#2A1F18] leading-snug truncate"
                          style={fraunces(isActive ? 400 : 300)}
                        >
                          {routine.name}
                        </p>
                      )}
                      <p className="text-[#4A3728] text-xs font-[Inter] font-light opacity-45 mt-1 leading-relaxed">
                        {getElementPreview(routine)}
                      </p>
                    </button>

                    <div className="flex items-center gap-3 shrink-0">
                      {isActive && (
                        <span className="text-[10px] font-[Inter] font-medium uppercase tracking-[0.22em] text-[#4A3728]/70">
                          active
                        </span>
                      )}
                      <button
                        onClick={() => {
                          resetMenuState();
                          setOpenMenuId(isMenuOpen ? null : routine.id);
                        }}
                        className="text-[#4A3728] text-base font-[Inter] opacity-50 hover:opacity-80 transition-opacity px-1"
                        aria-label="More options"
                      >
                        ···
                      </button>
                    </div>
                  </div>

                  {/* Action menu */}
                  {isMenuOpen && (
                    <div className="pb-4 flex gap-5 flex-wrap">
                      {!isActive && (
                        <button
                          onClick={() => handleSetActive(routine.id)}
                          className="text-[#2A1F18] text-xs font-[Inter] opacity-60 hover:opacity-100 transition-opacity"
                        >
                          set active
                        </button>
                      )}
                      <button
                        onClick={() => handleDuplicate(routine.id)}
                        className="text-[#4A3728] text-xs font-[Inter] opacity-60 hover:opacity-100 transition-opacity"
                      >
                        duplicate
                      </button>
                      <button
                        onClick={() => startRename(routine.id, routine.name)}
                        className="text-[#4A3728] text-xs font-[Inter] opacity-60 hover:opacity-100 transition-opacity"
                      >
                        rename
                      </button>
                      {isOnlyRoutine ? (
                        <span className="text-[#4A3728] text-xs font-[Inter] opacity-25 cursor-default">
                          delete (last routine)
                        </span>
                      ) : (
                        <button
                          onClick={() => startDelete(routine.id)}
                          className="text-red-400/60 text-xs font-[Inter] hover:text-red-400/90 transition-colors"
                        >
                          delete
                        </button>
                      )}
                    </div>
                  )}

                  {/* Delete confirmation */}
                  {isDeleteConfirm && (
                    <div className="pb-4 flex flex-col gap-2">
                      <p className="text-[#4A3728] text-xs font-[Inter] opacity-60">
                        Delete &ldquo;{routine.name}&rdquo;?
                      </p>
                      <div className="flex gap-4">
                        <button
                          onClick={() => confirmDelete(routine.id)}
                          className="text-red-400/70 text-xs font-[Inter] hover:text-red-400 transition-colors"
                        >
                          Delete
                        </button>
                        <button
                          onClick={() => setDeleteConfirmId(null)}
                          className="text-[#4A3728] text-xs font-[Inter] opacity-40 hover:opacity-70 transition-opacity"
                        >
                          nevermind
                        </button>
                      </div>
                    </div>
                  )}

                  {idx < arr.length - 1 && <Rule />}
                </div>
              );
            })}
          </div>

          {/* New Routine */}
          {showNewForm ? (
            <div className="flex flex-col gap-4 border-t border-[#2A1F18]/10 pt-6">
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleCreateNew(); if (e.key === "Escape") { setShowNewForm(false); setNewName(""); } }}
                placeholder="routine name"
                autoFocus
                autoCapitalize="words"
                className="w-full bg-transparent text-[#2A1F18] text-[22px] border-b border-[#2A1F18]/20 pb-2 pt-1 focus:outline-none focus:border-[#2A1F18]/35 transition-colors placeholder:text-[#4A3728]/30"
                style={fraunces(300)}
              />
              <div className="flex gap-4">
                <button
                  onClick={handleCreateNew}
                  disabled={!newName.trim()}
                  className="text-[#2A1F18] text-sm font-[Inter] font-medium opacity-80 hover:opacity-100 transition-opacity disabled:opacity-25"
                >
                  Create
                </button>
                <button
                  onClick={() => { setShowNewForm(false); setNewName(""); }}
                  className="text-[#4A3728] text-sm font-[Inter] opacity-40 hover:opacity-70 transition-opacity"
                >
                  cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => { resetMenuState(); setShowNewForm(true); }}
              className="flex items-center gap-2.5 border-t border-[#2A1F18]/10 pt-6 text-[#4A3728] text-sm font-[Inter] opacity-60 hover:opacity-90 transition-opacity w-full text-left"
            >
              <span className="text-lg leading-none opacity-70">+</span>
              New routine
            </button>
          )}
        </motion.div>
      </div>
    </>)
  );
}
