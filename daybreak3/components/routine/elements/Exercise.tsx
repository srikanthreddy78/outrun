"use client";

import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/Button";
import { playTimerDone } from "@/lib/audio";
import { hapticSuccess } from "@/lib/haptics";
import { useWakeLock } from "@/hooks/useWakeLock";

interface ExerciseProps {
  onNext: () => void;
  onSkip: () => void;
  durationSeconds?: number;
}

function ProgressRing({ progress }: { progress: number }) {
  const r = 70;
  const circ = 2 * Math.PI * r;
  return (
    <svg width="160" height="160" viewBox="0 0 160 160" style={{ transform: "rotate(-90deg)" }}>
      <circle cx="80" cy="80" r={r} fill="none" stroke="rgba(42,31,24,0.12)" strokeWidth="2.5" />
      <circle
        cx="80" cy="80" r={r} fill="none"
        stroke="rgba(42,31,24,0.45)" strokeWidth="2.5"
        strokeDasharray={circ}
        strokeDashoffset={circ * (1 - progress)}
        strokeLinecap="round"
        style={{ transition: "stroke-dashoffset 1s linear" }}
      />
    </svg>
  );
}

function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m}:${sec.toString().padStart(2, "0")}` : `${s}s`;
}

export function Exercise({ onNext, onSkip, durationSeconds = 600 }: ExerciseProps) {
  const [started, setStarted] = useState(false);
  const [remaining, setRemaining] = useState(durationSeconds);
  const onNextRef = useRef(onNext);
  useEffect(() => { onNextRef.current = onNext; }, [onNext]);

  // Hold the screen awake while the timer runs.
  useWakeLock(started);

  useEffect(() => {
    if (!started) {
      setRemaining(durationSeconds);
      return;
    }
    // Wall-clock based: derive remaining from an absolute end timestamp so the
    // countdown stays accurate across a brief background/screen-lock instead of
    // freezing where it paused.
    const endAt = Date.now() + durationSeconds * 1000;
    let done = false;
    const tick = () => {
      const left = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
      setRemaining(left);
      if (left <= 0 && !done) {
        done = true;
        clearInterval(id);
        playTimerDone();
        hapticSuccess();
        setTimeout(() => onNextRef.current(), 600);
      }
    };
    const id = setInterval(tick, 250);
    tick();
    return () => clearInterval(id);
  }, [started, durationSeconds]);

  const progress = started ? 1 - remaining / durationSeconds : 0;

  return (
    <div className="flex flex-col items-center justify-start min-h-full pt-[18vh] px-8 gap-12 text-center">
      <p className="text-[11px] font-[Inter] font-medium uppercase tracking-[0.24em] text-[#4A3728]/70">
        Exercise
      </p>

      <div className="flex flex-col items-center gap-6">
        <p
          className="text-3xl leading-snug text-[#2A1F18]"
          style={{ fontFamily: "var(--font-fraunces), Georgia, serif", fontWeight: 300 }}
        >
          Time to move.
        </p>

        <div className="relative flex items-center justify-center mt-4">
          <ProgressRing progress={progress} />
          <p className="absolute text-[#4A3728] text-xs font-[Inter] opacity-50">
            {started ? formatTime(remaining) : formatTime(durationSeconds)}
          </p>
        </div>
      </div>

      <div className="flex flex-col items-center gap-4">
        {!started ? (
          <>
            <Button onClick={() => setStarted(true)}>Start</Button>
            <Button variant="ghost" onClick={onSkip}>skip</Button>
          </>
        ) : (
          <>
            <Button onClick={onNext}>Done</Button>
            <Button variant="ghost" onClick={onSkip}>end early</Button>
          </>
        )}
      </div>
    </div>
  );
}
