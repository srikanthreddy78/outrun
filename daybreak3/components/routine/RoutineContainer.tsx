"use client";

import { useState, useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { storage } from "@/lib/storage";
import type { CustomElement, RoutineElement } from "@/types";

import { playStep } from "@/lib/audio";
import { hapticLight } from "@/lib/haptics";
import { Greeting } from "./elements/Greeting";
import { Weather } from "./elements/Weather";
import { Quote } from "./elements/Quote";
import { Breathe } from "./elements/Breathe";
import { Gratitude } from "./elements/Gratitude";
import { Intention } from "./elements/Intention";
import { Reflection } from "./elements/Reflection";
import { Notes } from "./elements/Notes";
import { Exercise } from "./elements/Exercise";
import { Water } from "./elements/Water";
import { CustomPrompt } from "./elements/CustomPrompt";
import { CustomTimer } from "./elements/CustomTimer";
import { CustomConfirm } from "./elements/CustomConfirm";
import { Launch } from "./Launch";

const stepVariants = {
  enter: (dir: number) => ({ opacity: 0, y: dir >= 0 ? 16 : -16 }),
  center: { opacity: 1, y: 0 },
  exit: (dir: number) => ({ opacity: 0, y: dir >= 0 ? -16 : 16 }),
};

const transition = { duration: 0.5, ease: [0.25, 0.1, 0.25, 1] as const };

interface RoutineContainerProps {
  onComplete: () => void;
}

export function RoutineContainer({ onComplete }: RoutineContainerProps) {
  const [elements, setElements] = useState<RoutineElement[]>([]);
  const [customElements, setCustomElements] = useState<CustomElement[]>([]);
  const [activeRoutineId, setActiveRoutineId] = useState("");
  const [stepIndex, setStepIndex] = useState(0);
  const [direction, setDirection] = useState(1);

  useEffect(() => {
    const customs = storage.getCustomElements();
    const customIds = new Set(customs.map((c) => c.id));
    const activeId = storage.getActiveRoutineId();
    const routine = storage.getRoutine(activeId);
    if (!routine) return;
    const filtered = routine.elements.filter(
      (e) => e.type !== "reflection" && (e.type !== "custom" || customIds.has(e.customElementId ?? ""))
    );
    setElements(filtered);
    setCustomElements(customs);
    setActiveRoutineId(activeId);
  }, []);

  if (elements.length === 0) return (
    <div className="flex flex-col items-center justify-center min-h-full px-8 gap-8 text-center">
      <p className="text-[#4A3728] text-sm font-[Inter] opacity-50">this routine has no steps.</p>
      <button
        onClick={onComplete}
        className="text-[#4A3728] text-sm font-[Inter] opacity-40 hover:opacity-70 transition-opacity"
      >
        continue →
      </button>
    </div>
  );

  const totalSteps = elements.length + 1;
  const isLaunch = stepIndex === elements.length;

  const handleNext = () => {
    playStep();
    hapticLight();
    setDirection(1);
    if (stepIndex < totalSteps - 1) {
      setStepIndex((i) => i + 1);
    } else {
      onComplete();
    }
  };

  const handleDotClick = (i: number) => {
    if (i < stepIndex) {
      hapticLight();
      setDirection(-1);
      setStepIndex(i);
    }
  };

  const stepProps = { onNext: handleNext, onSkip: handleNext };

  function renderElement(el: RoutineElement): React.ReactNode {
    switch (el.type) {
      case "greeting":   return <Greeting {...stepProps} />;
      case "weather":    return <Weather {...stepProps} />;
      case "quote":      return <Quote {...stepProps} />;
      case "breathe":    return <Breathe {...stepProps} cycles={el.settings?.cycles} pattern={el.settings?.pattern} />;
      case "gratitude":  return <Gratitude {...stepProps} />;
      case "intention":  return <Intention {...stepProps} />;
      case "reflection": return <Reflection {...stepProps} />;
      case "notes":      return <Notes {...stepProps} notes={el.settings?.notes} elementId={el.id} routineId={activeRoutineId} />;
      case "exercise":   return <Exercise {...stepProps} durationSeconds={el.settings?.durationSeconds} />;
      case "water":      return <Water {...stepProps} />;
      case "custom": {
        const customEl = customElements.find((c) => c.id === el.customElementId);
        if (!customEl) return null;
        switch (customEl.type) {
          case "prompt":  return <CustomPrompt label={customEl.label} emoji={customEl.emoji} description={customEl.description} elementId={customEl.id} {...stepProps} />;
          case "timer":   return <CustomTimer label={customEl.label} emoji={customEl.emoji} durationSeconds={customEl.settings?.durationSeconds ?? 60} {...stepProps} />;
          case "confirm": return <CustomConfirm label={customEl.label} emoji={customEl.emoji} description={customEl.description} {...stepProps} />;
          default:        return null;
        }
      }
      default: return null;
    }
  }

  const currentEl = elements[stepIndex];
  const stepKey = isLaunch ? "launch" : currentEl.id;
  const renderedEl = isLaunch ? <Launch {...stepProps} /> : renderElement(currentEl);
  // If a custom element can't be resolved (missing data), skip it automatically
  const stepContent = renderedEl ?? (
    <div className="flex flex-col items-center justify-center min-h-full px-8 gap-8 text-center">
      <button
        onClick={handleNext}
        className="text-[#4A3728] text-sm font-[Inter] opacity-50 hover:opacity-80 transition-opacity"
      >
        continue
      </button>
    </div>
  );

  return (
    <div className="relative w-full h-full">
      <div className="absolute top-6 left-1/2 -translate-x-1/2 flex z-10">
        {Array.from({ length: totalSteps }).map((_, i) => (
          <button
            key={i}
            onClick={() => handleDotClick(i)}
            className="px-1 py-3 flex items-center justify-center group"
            style={{ cursor: i < stepIndex ? "pointer" : "default" }}
            aria-label={i < stepIndex ? `Back to step ${i + 1}` : undefined}
          >
            <motion.div
              className="w-1 h-1 rounded-full"
              style={{ backgroundColor: "#2A1F18" }}
              animate={{
                opacity: i === stepIndex ? 0.6 : i < stepIndex ? 0.35 : 0.15,
                scale: i === stepIndex ? 1.4 : 1,
              }}
              whileTap={i < stepIndex ? { opacity: 0.65, scale: 1.6 } : undefined}
              transition={{ duration: 0.2 }}
            />
          </button>
        ))}
      </div>

      {/* Crossfade (not mode="wait") so the entering step overlaps the exiting
          one — no dead gap between modules. Steps are absolutely stacked. */}
      <AnimatePresence custom={direction}>
        <motion.div
          key={stepKey}
          custom={direction}
          variants={stepVariants}
          initial="enter"
          animate="center"
          exit="exit"
          transition={transition}
          className="absolute inset-0 w-full h-full"
        >
          {stepContent}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
