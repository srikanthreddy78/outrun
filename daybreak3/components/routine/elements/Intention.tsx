"use client";

import { useState, useEffect } from "react";
import { storage } from "@/lib/storage";
import { getTodayKey } from "@/lib/time";
import { Button } from "@/components/ui/Button";
import { fraunces, Label } from "@/components/ui/kit";


interface IntentionProps {
  onNext: () => void;
  onSkip: () => void;
}

export function Intention({ onNext }: IntentionProps) {
  const [text, setText] = useState("");
  const today = getTodayKey();

  useEffect(() => {
    setText(storage.getIntention(today));
  }, [today]);

  const handleBlur = () => {
    storage.setIntention(today, text);
  };

  const handleNext = () => {
    storage.setIntention(today, text);
    onNext();
  };

  return (
    <div className="flex flex-col items-center justify-start min-h-full pt-[28vh] px-8 gap-10 w-full">
      <div className="flex flex-col items-center gap-3">
        <Label>Intention</Label>
        <p className="text-[17px] text-[#4A3728] opacity-70" style={fraunces(300, true)}>
          today is for
        </p>
      </div>

      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={handleBlur}
        onKeyDown={(e) => e.key === "Enter" && handleNext()}
        placeholder="one word for the day"
        autoCapitalize="sentences"
        autoComplete="off" name="db-intention"
        spellCheck
        className="w-full max-w-xs bg-transparent text-[#2A1F18] text-[22px] text-center border-b border-[#2A1F18]/20 pb-2 pt-1 focus:outline-none focus:border-[#2A1F18]/35 transition-colors placeholder:text-[#4A3728]/30"
        style={fraunces(300)}
      />

      <div className="flex flex-col items-center gap-4">
        <Button onClick={handleNext}>Continue</Button>
      </div>
    </div>
  );
}
