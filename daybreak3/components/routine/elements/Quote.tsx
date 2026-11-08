"use client";

import { getDayOfYear } from "@/lib/time";
import { Button } from "@/components/ui/Button";
import quotes from "@/lib/quotes.json";

interface QuoteProps {
  onNext: () => void;
  onSkip: () => void;
}

const todaysQuote = quotes[getDayOfYear() % quotes.length];

export function Quote({ onNext, onSkip }: QuoteProps) {
  return (
    <div className="flex flex-col items-center justify-start min-h-full pt-[28vh] px-8 text-center gap-12">
      <div className="flex flex-col gap-6 max-w-sm">
        <p className="text-[11px] font-[Inter] font-medium uppercase tracking-[0.24em] text-[#4A3728]/70">Quote of the day</p>
        <blockquote
          className="text-2xl leading-relaxed text-[#2A1F18]"
          style={{
            fontFamily: "var(--font-fraunces), Georgia, serif",
            fontWeight: 300,
            fontStyle: "italic",
          }}
        >
          &ldquo;{todaysQuote.text}&rdquo;
        </blockquote>
        <p className="text-[#4A3728] text-sm font-[Inter] tracking-wide">
          — {todaysQuote.author}
        </p>
      </div>

      <div className="flex flex-col items-center gap-4">
        <Button onClick={onNext}>Continue</Button>
        <Button variant="ghost" onClick={onSkip}>skip</Button>
      </div>
    </div>
  );
}
