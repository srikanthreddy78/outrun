import type { ElementType } from "@/types";

export type ElementMeta = {
  name: string;
  description: string;
  hasSettings: boolean;
};

export const ELEMENT_META: Record<ElementType, ElementMeta> = {
  greeting:   { name: "Greeting",   description: "Good morning.",                  hasSettings: false },
  weather:    { name: "Weather",    description: "Today's forecast.",              hasSettings: false },
  quote:      { name: "Quote",      description: "A daily word.",                  hasSettings: false },
  breathe:    { name: "Breathe",    description: "Guided breathing.",              hasSettings: true  },
  gratitude:  { name: "Gratitude",  description: "One thing you're grateful for.", hasSettings: false },
  intention:  { name: "Intention",  description: "Set your intention.",            hasSettings: false },
  reflection: { name: "Reflection", description: "Check in with yourself.",        hasSettings: false },
  notes:      { name: "Notes",      description: "A note to yourself.",            hasSettings: true  },
  exercise:   { name: "Exercise",   description: "Time to move.",                  hasSettings: true  },
  water:      { name: "Water",      description: "Drink a glass of water.",        hasSettings: false },
};
