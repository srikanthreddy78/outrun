"use client";

import { useState, useEffect } from "react";
import { storage } from "@/lib/storage";
import { getTodayKey } from "@/lib/time";
import { Button } from "@/components/ui/Button";
import { fraunces, Label } from "@/components/ui/kit";

interface GratitudeProps {
  onNext: () => void;
  onSkip: () => void;
}

export function Gratitude({ onNext }: GratitudeProps) {
  const [value, setValue] = useState("");
  const today = getTodayKey();

  useEffect(() => {
    setValue(storage.getGratitudeEntry(today));
  }, [today]);

  const save = (v: string) => storage.setGratitudeEntry(today, v);

  const handleNext = () => {
    save(value);
    onNext();
  };

  return (
    <div className="flex flex-col items-center justify-start min-h-full pt-[28vh] px-8 gap-10 w-full">
      <div className="flex flex-col items-center gap-3">
        <Label>Gratitude</Label>
        <p
          className="text-[17px] text-[#4A3728] opacity-70"
          style={fraunces(300, true)}
        >
          today I&apos;m grateful for
        </p>
      </div>

      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => save(value)}
        onKeyDown={(e) => e.key === "Enter" && handleNext()}
        placeholder="a person, a moment, a thing"
        autoFocus
        autoCapitalize="sentences"
        autoComplete="off" name="db-gratitude"
        spellCheck
        className="w-full max-w-xs bg-transparent text-[#2A1F18] text-[22px] text-center border-b border-[#2A1F18]/15 pb-2 focus:outline-none focus:border-[#2A1F18]/35 transition-colors placeholder:text-[#4A3728]/30"
        style={fraunces(300)}
      />

      <div className="flex flex-col items-center gap-4">
        <Button onClick={handleNext}>Continue</Button>
      </div>
    </div>
  );
}
