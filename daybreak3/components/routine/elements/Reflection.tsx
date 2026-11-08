"use client";

import { useState, useEffect } from "react";
import { storage } from "@/lib/storage";
import { getTodayKey } from "@/lib/time";
import { Button } from "@/components/ui/Button";

interface ReflectionProps {
  onNext: () => void;
  onSkip: () => void;
}

export function Reflection({ onNext, onSkip }: ReflectionProps) {
  const [text, setText] = useState("");
  const today = getTodayKey();

  useEffect(() => {
    setText(storage.getJournalEntry(today));
  }, [today]);

  const handleBlur = () => {
    storage.setJournalEntry(today, text);
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-full px-8 gap-10 w-full">
      <div className="flex flex-col gap-3 text-center">
        <p className="text-[11px] font-[Inter] font-medium uppercase tracking-[0.24em] text-[#4A3728]/70">
          Check in
        </p>
        <h2
          className="text-3xl leading-snug text-[#2A1F18]"
          style={{ fontFamily: "var(--font-fraunces), Georgia, serif", fontWeight: 300 }}
        >
          How are you arriving today?
        </h2>
      </div>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={handleBlur}
        autoCapitalize="sentences"
        autoComplete="off"
        spellCheck
        className="w-full max-w-sm h-40 bg-[#2A1F18]/5 border border-[#2A1F18]/10 rounded-2xl px-5 py-4 text-[#2A1F18] text-base font-[Inter] font-light leading-relaxed resize-none focus:outline-none focus:border-[#2A1F18]/25 transition-colors"
      />

      <div className="flex flex-col items-center gap-4">
        <Button onClick={onNext}>Continue</Button>
        <Button variant="ghost" onClick={onSkip}>skip</Button>
      </div>
    </div>
  );
}
