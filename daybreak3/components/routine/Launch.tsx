"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/Button";
import { storage } from "@/lib/storage";
import { getTodayKey, getDayOfYear } from "@/lib/time";
import { fraunces } from "@/components/ui/kit";

const CLOSINGS = [
  "Have a beautiful day.",
  "Go make it yours.",
  "Something good is ahead.",
  "The rest is yours.",
  "go gently.",
  "the day is waiting.",
  "make it count.",
  "the hard part's done.",
];
import { playComplete } from "@/lib/audio";
import { hapticSuccess } from "@/lib/haptics";

interface LaunchProps {
  onNext: () => void;
  onSkip: () => void;
}

export function Launch({ onNext }: LaunchProps) {
  const [intention, setIntention] = useState("");
  const [hasIntentionElement, setHasIntentionElement] = useState(false);

  useEffect(() => { playComplete(); hapticSuccess(); }, []);

  useEffect(() => {
    setIntention(storage.getIntention(getTodayKey()));
    const activeId = storage.getActiveRoutineId();
    const routine = storage.getRoutine(activeId);
    if (routine) {
      setHasIntentionElement(routine.elements.some((el) => el.type === "intention"));
    }
  }, []);

  return (
    <div
      className="flex flex-col items-center justify-start min-h-full px-8 text-center gap-12 pt-[28vh]"
      style={{ textShadow: "0 1px 16px rgba(255,248,232,0.55)" }}
    >
      <div className="flex flex-col gap-5">
        <h2
          className="text-6xl leading-[1.0] text-[#2A1F18]"
          style={fraunces(300)}
        >
          You&apos;re ready.
        </h2>
        {hasIntentionElement && intention ? (
          <div className="flex flex-col gap-2">
            <p className="text-[21px] leading-snug text-[#2A1F18] line-clamp-3" style={fraunces(300, true)}>
              today is for {intention.toLowerCase()}
            </p>
            <p className="text-[11px] font-[Inter] font-medium uppercase tracking-[0.24em] text-[#4A3728]/60">
              go live it
            </p>
          </div>
        ) : (
          <p className="text-[21px] leading-snug text-[#2A1F18]" style={fraunces(300, true)}>
            {CLOSINGS[getDayOfYear() % CLOSINGS.length]}
          </p>
        )}
      </div>

      <Button onClick={() => { onNext(); }}>Begin my day</Button>
    </div>
  );
}
