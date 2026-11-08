"use client";

import { useState, useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/Button";
import { playInhale, playExhale } from "@/lib/audio";
import { useWakeLock } from "@/hooks/useWakeLock";
import { breathePattern } from "@/lib/breathe";
import type { BreathePatternId } from "@/types";

type Phase = "inhale" | "hold" | "exhale";

const PHASE_LABEL: Record<Phase, string> = { inhale: "inhale", hold: "hold", exhale: "exhale" };

interface BreatheProps {
  onNext: () => void;
  onSkip: () => void;
  cycles?: number;
  pattern?: BreathePatternId;
}

export function Breathe({ onNext, onSkip, cycles = 2, pattern }: BreatheProps) {
  const p = breathePattern(pattern);
  const phaseMs: Record<Phase, number> = { inhale: p.inhale, hold: p.hold, exhale: p.exhale };
  // Skip the hold beat entirely when the pattern has no hold (even breathing).
  const nextPhase: Record<Phase, Phase> = {
    inhale: p.hold > 0 ? "hold" : "exhale",
    hold: "exhale",
    exhale: "inhale",
  };

  const [started, setStarted] = useState(false);
  const [phase, setPhase] = useState<Phase>("inhale");
  const [cycle, setCycle] = useState(1);
  const [complete, setComplete] = useState(false);
  const onNextRef = useRef(onNext);
  useEffect(() => { onNextRef.current = onNext; }, [onNext]);

  // Keep the screen awake through the breathing cycles.
  useWakeLock(started && !complete);

  useEffect(() => {
    if (!started) return;
    if (complete) return;
    const t = setTimeout(() => {
      if (phase === "exhale") {
        if (cycle >= cycles) {
          setComplete(true);
        } else {
          setCycle((c) => c + 1);
          setPhase("inhale");
        }
      } else {
        setPhase(nextPhase[phase]);
      }
    }, phaseMs[phase]);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, cycle, cycles, complete, started]);

  useEffect(() => {
    if (!started || complete) return;
    if (phase === "inhale") playInhale();
    else if (phase === "exhale") playExhale();
  }, [phase, started, complete]);

  const circleScale = !started ? 0.55 : phase === "exhale" ? 0.55 : 1;
  const scaleDuration = !started ? 0 : phase === "inhale" ? p.inhale / 1000 : phase === "exhale" ? p.exhale / 1000 : 0.05;

  const glowBright = "0 0 48px 18px rgba(245, 165, 30, 0.62), 0 0 100px 48px rgba(245, 178, 32, 0.28), 0 0 180px 80px rgba(245, 178, 32, 0.11)";
  const glowDim    = "0 0 14px  4px rgba(210, 130, 40, 0.15), 0 0  32px 12px rgba(210, 130, 40, 0.07), 0 0  60px 24px rgba(210, 130, 40, 0.03)";
  const glowIdle   = "0 0 28px 10px rgba(220, 148, 40, 0.30), 0 0  60px 24px rgba(220, 148, 40, 0.12), 0 0 110px 44px rgba(220, 148, 40, 0.05)";

  const boxShadow = !started ? glowIdle : phase === "exhale" ? glowDim : glowBright;
  const glowDuration = scaleDuration;

  return (
    <div className="flex flex-col items-center justify-start min-h-full pt-[28vh] px-8 gap-14 text-center">
      <p className="text-[11px] font-[Inter] font-medium uppercase tracking-[0.24em] text-[#4A3728]/70">
        Breathe
      </p>

      <div className="flex flex-col items-center gap-8">
        <motion.div
          initial={{ scale: 0.55, boxShadow: glowIdle }}
          animate={{ scale: circleScale, boxShadow }}
          transition={{ duration: glowDuration, ease: "easeInOut" }}
          style={{
            width: 160,
            height: 160,
            borderRadius: "50%",
            background: "radial-gradient(circle at 45% 40%, #F8E090 0%, #F5C078 55%, #EAA060 100%)",
          }}
        />

        <motion.p
          key={started ? phase : "idle"}
          initial={{ opacity: 0 }}
          animate={{ opacity: started && !complete ? 0.6 : 0 }}
          transition={{ duration: 0.4 }}
          className="text-[11px] font-[Inter] font-medium uppercase tracking-[0.24em] text-[#4A3728]/70"
          style={{ minHeight: "1.25rem" }}
        >
          {started && !complete && PHASE_LABEL[phase]}
        </motion.p>

        {started && (
          <p className="text-[#4A3728] text-xs font-[Inter] opacity-35">
            {cycle} of {cycles}
          </p>
        )}
      </div>

      <div className="flex flex-col items-center gap-4">
        {!started ? (
          <>
            <Button onClick={() => setStarted(true)}>Start</Button>
            <Button variant="ghost" onClick={onSkip}>skip</Button>
          </>
        ) : complete ? (
          <Button onClick={onNext}>Continue</Button>
        ) : (
          <button
            onClick={onSkip}
            className="text-[#4A3728] text-sm font-[Inter] opacity-40 hover:opacity-70 transition-opacity"
          >
            end early
          </button>
        )}
      </div>
    </div>
  );
}
