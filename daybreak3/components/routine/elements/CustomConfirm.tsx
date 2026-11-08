"use client";

import { Button } from "@/components/ui/Button";

interface CustomConfirmProps {
  label: string;
  emoji?: string;
  description?: string;
  onNext: () => void;
  onSkip: () => void;
}

export function CustomConfirm({ label, emoji, description, onNext }: CustomConfirmProps) {
  return (
    <div className="flex flex-col items-center justify-start min-h-full pt-[28vh] px-8 gap-12 text-center">
      <div className="flex flex-col items-center gap-4">
        {emoji && (
          <span className="text-4xl leading-none" aria-hidden="true">{emoji}</span>
        )}
        <p
          className="text-3xl leading-snug text-[#2A1F18]"
          style={{ fontFamily: "var(--font-fraunces), Georgia, serif", fontWeight: 300 }}
        >
          {label}
        </p>
        {description && (
          <p className="text-[#4A3728] text-sm font-[Inter] font-light max-w-xs opacity-70">
            {description}
          </p>
        )}
      </div>
      <Button onClick={onNext}>Done</Button>
    </div>
  );
}
