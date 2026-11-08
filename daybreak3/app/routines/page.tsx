"use client";

import { useState } from "react";
import { RoutinesList } from "@/components/routines/RoutinesList";
import { RoutineBuilder } from "@/components/builder/RoutineBuilder";

export default function RoutinesPage() {
  const [editingId, setEditingId] = useState<string | null>(null);

  if (editingId) {
    return (
      <RoutineBuilder
        routineId={editingId}
        onClose={() => setEditingId(null)}
      />
    );
  }

  return <RoutinesList onOpen={setEditingId} />;
}
