"use client";

import { Button } from "@/components/ui/Button";

interface WaterProps {
  onNext: () => void;
  onSkip: () => void;
}

export function Water({ onNext }: WaterProps) {
  return (
    <div className="flex flex-col items-center justify-start min-h-full pt-[28vh] px-8 gap-12 text-center">
      <p className="text-[11px] font-[Inter] font-medium uppercase tracking-[0.24em] text-[#4A3728]/70">
        Water
      </p>

      <p
        className="text-3xl leading-snug text-[#2A1F18]"
        style={{ fontFamily: "var(--font-fraunces), Georgia, serif", fontWeight: 300 }}
      >
        Drink a glass of water.
      </p>

      <Button onClick={onNext}>Done</Button>
    </div>
  );
}
