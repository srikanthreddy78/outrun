import type { MorningVibe, Routine, RoutineElement } from "@/types";

function genId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2, 11) + Date.now().toString(36);
}

export function getVibeElements(vibe: MorningVibe): RoutineElement[] {
  switch (vibe) {
    case "peaceful":
      return [
        { id: genId(), type: "greeting" },
        { id: genId(), type: "breathe", settings: { cycles: 3 } },
        { id: genId(), type: "quote" },
        { id: genId(), type: "intention" },
        { id: genId(), type: "gratitude" },
      ];
    case "focused":
      return [
        { id: genId(), type: "greeting" },
        { id: genId(), type: "weather" },
        { id: genId(), type: "intention" },
        { id: genId(), type: "notes" },
        { id: genId(), type: "gratitude" },
      ];
    case "energised":
      return [
        { id: genId(), type: "greeting" },
        { id: genId(), type: "weather" },
        { id: genId(), type: "exercise", settings: { durationSeconds: 120 } },
        { id: genId(), type: "water" },
        { id: genId(), type: "intention" },
        { id: genId(), type: "gratitude" },
      ];
    case "present":
      return [
        { id: genId(), type: "greeting" },
        { id: genId(), type: "breathe", settings: { cycles: 2 } },
        { id: genId(), type: "gratitude" },
        { id: genId(), type: "intention" },
        { id: genId(), type: "quote" },
      ];
  }
}

export function createDefaultRoutine(id: string, name: string): Routine {
  return {
    id,
    name,
    createdAt: new Date().toISOString(),
    elements: [
      { id: genId(), type: "greeting" },
      { id: genId(), type: "weather" },
      { id: genId(), type: "breathe", settings: { cycles: 2 } },
      { id: genId(), type: "quote" },
      { id: genId(), type: "intention" },
      { id: genId(), type: "gratitude" },
    ],
  };
}
