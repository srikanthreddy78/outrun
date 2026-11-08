"use client";

import { useState, useEffect } from "react";
import { storage } from "@/lib/storage";
import { getTodayKey } from "@/lib/time";
import { Button } from "@/components/ui/Button";

interface CustomPromptProps {
  label: string;
  emoji?: string;
  description?: string;
  elementId: string;
  onNext: () => void;
  onSkip: () => void;
}

export function CustomPrompt({ label, emoji, description, elementId, onNext }: CustomPromptProps) {
  const [text, setText] = useState("");
  const today = getTodayKey();

  useEffect(() => {
    setText(storage.getCustomElementEntry(elementId, today));
  }, [elementId, today]);

  const handleBlur = () => {
    storage.setCustomElementEntry(elementId, today, text);
  };

  const handleNext = () => {
    storage.setCustomElementEntry(elementId, today, text);
    onNext();
  };

  return (
    <div className="flex flex-col items-center justify-start min-h-full pt-[28vh] px-8 gap-10 w-full">
      <div className="flex flex-col items-center gap-4">
        {emoji && (
          <span className="text-4xl leading-none" aria-hidden="true">{emoji}</span>
        )}
        <h2
          className="text-3xl leading-snug text-[#2A1F18] text-center"
          style={{ fontFamily: "var(--font-fraunces), Georgia, serif", fontWeight: 300 }}
        >
          {label}
        </h2>
        {description && (
          <p className="text-[#4A3728] text-sm font-[Inter] font-light text-center max-w-xs opacity-70">
            {description}
          </p>
        )}
      </div>

      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={handleBlur}
        onKeyDown={(e) => e.key === "Enter" && handleNext()}
        autoCapitalize="sentences"
        autoComplete="off" name="db-prompt"
        spellCheck
        className="w-full max-w-xs bg-transparent text-[#2A1F18] text-[22px] text-center border-b border-[#2A1F18]/20 pb-2 pt-1 focus:outline-none focus:border-[#2A1F18]/35 transition-colors placeholder:text-[#4A3728]/30"
        style={{ fontFamily: "var(--font-fraunces), Georgia, serif", fontWeight: 300 }}
      />

      <div className="flex flex-col items-center gap-4">
        <Button onClick={handleNext}>Continue</Button>
      </div>
    </div>
  );
}
