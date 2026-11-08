"use client";

import { useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { useWakeLock } from "@/hooks/useWakeLock";

interface SilenceProps {
  onNext: () => void;
  onSkip: () => void;
  durationSeconds?: number;
}

export function Silence({ onNext, onSkip, durationSeconds = 30 }: SilenceProps) {
  const onNextRef = useRef(onNext);
  useEffect(() => { onNextRef.current = onNext; }, [onNext]);

  // Silence runs unattended (no controls), so keep the screen awake throughout.
  useWakeLock(true);

  useEffect(() => {
    // Wall-clock based: advance once the real end time is reached. If the app
    // was briefly backgrounded, the check on resume settles it immediately
    // rather than waiting out a frozen timeout.
    const endAt = Date.now() + durationSeconds * 1000;
    const id = setInterval(() => {
      if (Date.now() >= endAt) {
        clearInterval(id);
        onNextRef.current();
      }
    }, 250);
    return () => clearInterval(id);
  }, [durationSeconds]);

  return (
    <div
      className="flex flex-col items-center justify-center min-h-full px-8 cursor-pointer"
      onClick={onSkip}
    >
      <motion.p
        animate={{ opacity: [0.12, 0.4, 0.12] }}
        transition={{ duration: 3.5, repeat: Infinity, ease: "easeInOut" }}
        className="text-[#4A3728] text-2xl font-[Inter] font-light select-none"
      >
        …
      </motion.p>
    </div>
  );
}
