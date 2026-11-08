"use client";

import { useState, useEffect } from "react";
import { Reorder, motion } from "framer-motion";
import { storage } from "@/lib/storage";
import { ELEMENT_META } from "@/lib/element-meta";
import { estimateMinutes } from "@/lib/duration";
import type { CustomElement, ElementType, Routine, RoutineElement } from "@/types";
import { ElementCard } from "./ElementCard";
import { ElementLibrary } from "./ElementLibrary";
import { CustomElementList } from "./CustomElementList";
import { CreateCustomForm } from "./CreateCustomForm";
import { hapticLight } from "@/lib/haptics";

function genId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2, 11) + Date.now().toString(36);
}

function defaultSettings(type: ElementType): RoutineElement["settings"] {
  switch (type) {
    case "breathe":  return { cycles: 3, pattern: "calm" };
    case "exercise": return { durationSeconds: 600 };
    default:          return undefined;
  }
}

interface RoutineBuilderProps {
  routineId: string;
  onClose: () => void;
}

export function RoutineBuilder({ routineId, onClose }: RoutineBuilderProps) {
  const [elements, setElements] = useState<RoutineElement[]>([]);
  const [customElements, setCustomElements] = useState<CustomElement[]>([]);
  const [routineName, setRoutineName] = useState("");
  const [isActiveRoutine, setIsActiveRoutine] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"library" | "your-elements">("library");
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [editingCustomId, setEditingCustomId] = useState<string | null>(null);

  useEffect(() => {
    const routine = storage.getRoutine(routineId);
    if (!routine) { onClose(); return; }
    setElements(routine.elements);
    setRoutineName(routine.name);
    setIsActiveRoutine(storage.getActiveRoutineId() === routineId);
    setCustomElements(storage.getCustomElements());
  }, [routineId, onClose]);

  function save(updated: RoutineElement[]) {
    setElements(updated);
    storage.updateRoutine(routineId, { elements: updated });
  }

  const commitRename = () => {
    const trimmed = routineName.trim();
    if (trimmed) {
      storage.updateRoutine(routineId, { name: trimmed });
    } else {
      const stored = storage.getRoutine(routineId);
      setRoutineName(stored?.name ?? "My Routine");
    }
    setIsRenaming(false);
  };

  const locked = elements[0];
  const reorderables = elements.slice(1);

  const estMinutes = estimateMinutes(
    { id: routineId, name: routineName, elements, createdAt: "" } as Routine,
    customElements
  );

  const usedBuiltinTypes = new Set<ElementType>(
    elements.filter((e) => e.type !== "custom").map((e) => e.type as ElementType)
  );

  const handleReorder = (newOrder: RoutineElement[]) => {
    hapticLight(); // a tick as items swap past each other
    save([elements[0], ...newOrder]);
  };

  const handleRemove = (id: string) => {
    // Floor: a routine always keeps at least one element beyond the greeting.
    if (reorderables.length <= 1) return;
    if (expandedId === id) setExpandedId(null);
    hapticLight();
    save(elements.filter((e) => e.id !== id));
  };

  const handleAdd = (type: ElementType) => {
    hapticLight();
    save([...elements, { id: genId(), type, settings: defaultSettings(type) }]);
  };

  const handleAddCustom = (customElementId: string) => {
    hapticLight();
    save([...elements, { id: genId(), type: "custom", customElementId }]);
  };

  const handleUpdate = (updated: RoutineElement) => {
    save(elements.map((e) => (e.id === updated.id ? updated : e)));
  };

  const handleSaveCustom = (values: Pick<CustomElement, "type" | "label" | "emoji" | "description" | "settings">) => {
    hapticLight();
    if (editingCustomId) {
      const updated = customElements.map((c) =>
        c.id === editingCustomId ? { ...c, ...values } : c
      );
      setCustomElements(updated);
      storage.setCustomElements(updated);
      setEditingCustomId(null);
    } else {
      const newEl: CustomElement = {
        id: genId(),
        type: values.type,
        label: values.label,
        emoji: values.emoji,
        description: values.description,
        settings: values.settings,
        createdAt: new Date().toISOString(),
      };
      const updatedCustoms = [...customElements, newEl];
      setCustomElements(updatedCustoms);
      storage.setCustomElements(updatedCustoms);
      save([...elements, { id: genId(), type: "custom", customElementId: newEl.id }]);
      setShowCreateForm(false);
    }
  };

  const handleDeleteCustom = (id: string) => {
    storage.deleteCustomElement(id);
    setCustomElements((prev) => prev.filter((c) => c.id !== id));
    setElements((prev) => prev.filter((e) => !(e.type === "custom" && e.customElementId === id)));
    setEditingCustomId(null);
  };

  const switchTab = (tab: "library" | "your-elements") => {
    setActiveTab(tab);
    setShowCreateForm(false);
    setEditingCustomId(null);
  };

  const editingCustomEl = editingCustomId
    ? customElements.find((c) => c.id === editingCustomId)
    : undefined;

  const showingForm = showCreateForm || editingCustomId !== null;

  if (elements.length === 0) return <main className="dawn-gradient min-h-screen w-full" />;

  return (
    <main className="dawn-gradient min-h-screen w-full">
      <div className="w-full max-w-[600px] mx-auto px-6 pt-14 pb-24 flex flex-col gap-8">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: "easeOut" }}
          className="flex flex-col gap-8"
        >
          {/* Header — back + routine name */}
          <div className="flex items-start justify-between gap-4">
            <button
              onClick={onClose}
              className="text-[#4A3728] text-sm font-[Inter] opacity-60 hover:opacity-100 transition-opacity shrink-0 pt-1"
            >
              ← back
            </button>

            <div className="flex flex-col items-end gap-1 min-w-0">
              {isRenaming ? (
                <input
                  value={routineName}
                  onChange={(e) => setRoutineName(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename();
                    if (e.key === "Escape") {
                      const stored = storage.getRoutine(routineId);
                      setRoutineName(stored?.name ?? "");
                      setIsRenaming(false);
                    }
                  }}
                  autoFocus
                  className="text-3xl text-[#2A1F18] bg-transparent border-b border-[#2A1F18]/20 pb-1 focus:outline-none text-right max-w-full"
                  style={{ fontFamily: "var(--font-fraunces), Georgia, serif", fontWeight: 300 }}
                />
              ) : (
                <button
                  onClick={() => setIsRenaming(true)}
                  className="text-3xl text-[#2A1F18] text-right hover:opacity-70 transition-opacity leading-snug"
                  style={{ fontFamily: "var(--font-fraunces), Georgia, serif", fontWeight: 300 }}
                >
                  {routineName}
                </button>
              )}
              {isActiveRoutine ? (
                <span className="text-[#4A3728] text-xs font-[Inter] opacity-40">active</span>
              ) : (
                <button
                  onClick={() => {
                    storage.setActiveRoutineId(routineId);
                    setIsActiveRoutine(true);
                  }}
                  className="text-[#4A3728] text-xs font-[Inter] opacity-60 hover:opacity-90 transition-opacity px-2.5 py-0.5 rounded-full bg-[#2A1F18]/[0.06] border border-[#2A1F18]/10"
                >
                  set as active →
                </button>
              )}
            </div>
          </div>

          {/* Routine list */}
          <div className="flex flex-col gap-2">
            <p className="text-[#4A3728] text-xs font-[Inter] opacity-45 px-1 pb-1">
              about {estMinutes} minute{estMinutes === 1 ? "" : "s"}
            </p>
            {locked && (
              <div className="flex items-center gap-4 px-5 py-4 rounded-2xl bg-[#2A1F18]/[0.04] border border-[#2A1F18]/10">
                <div className="w-[10px] shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-[#2A1F18] text-sm font-[Inter] font-medium leading-tight">
                    {ELEMENT_META.greeting.name}
                  </p>
                  <p className="text-[#4A3728] text-xs font-[Inter] font-light mt-0.5 leading-tight">
                    {ELEMENT_META.greeting.description}
                  </p>
                </div>
                <p className="text-[#4A3728] text-xs font-[Inter] opacity-35 shrink-0">
                  always first
                </p>
              </div>
            )}

            <Reorder.Group
              axis="y"
              values={reorderables}
              onReorder={handleReorder}
              className="flex flex-col gap-2 list-none p-0 m-0"
            >
              {reorderables.map((el) => (
                <Reorder.Item
                  key={el.id}
                  value={el}
                  className="cursor-grab active:cursor-grabbing list-none"
                  whileDrag={{
                    scale: 1.015,
                    boxShadow: "0 8px 24px rgba(42,31,24,0.10)",
                    zIndex: 10,
                  }}
                >
                  <ElementCard
                    element={el}
                    customEl={
                      el.type === "custom"
                        ? customElements.find((c) => c.id === el.customElementId)
                        : undefined
                    }
                    isExpanded={expandedId === el.id}
                    canRemove={reorderables.length > 1}
                    onToggleSettings={() =>
                      setExpandedId((prev) => (prev === el.id ? null : el.id))
                    }
                    onRemove={() => handleRemove(el.id)}
                    onChange={handleUpdate}
                  />
                </Reorder.Item>
              ))}
            </Reorder.Group>
          </div>

          {/* Add Element — tabbed */}
          <div className="flex flex-col gap-4">
            <div className="flex gap-6 border-b border-[#2A1F18]/[0.06]">
              {(["library", "your-elements"] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => switchTab(tab)}
                  className={`text-sm font-[Inter] pb-3 transition-colors -mb-px ${
                    activeTab === tab
                      ? "text-[#2A1F18] border-b-2 border-[#C4936A]/60"
                      : "text-[#4A3728] opacity-40 hover:opacity-70"
                  }`}
                >
                  {tab === "library" ? "Library" : "Your Elements"}
                </button>
              ))}
            </div>

            {activeTab === "library" && (
              <ElementLibrary usedTypes={usedBuiltinTypes} onAdd={handleAdd} />
            )}

            {activeTab === "your-elements" && (
              showingForm ? (
                <CreateCustomForm
                  mode={editingCustomId ? "edit" : "create"}
                  initialValues={
                    editingCustomEl
                      ? { type: editingCustomEl.type, label: editingCustomEl.label, emoji: editingCustomEl.emoji, description: editingCustomEl.description, settings: editingCustomEl.settings }
                      : undefined
                  }
                  onSave={handleSaveCustom}
                  onCancel={() => { setShowCreateForm(false); setEditingCustomId(null); }}
                  onDelete={editingCustomId ? () => handleDeleteCustom(editingCustomId) : undefined}
                />
              ) : (
                <CustomElementList
                  customElements={customElements}
                  onAdd={handleAddCustom}
                  onEdit={(id) => setEditingCustomId(id)}
                  onCreateNew={() => setShowCreateForm(true)}
                />
              )
            )}
          </div>
        </motion.div>
      </div>
    </main>
  );
}
