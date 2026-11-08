"use client";

import { useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { storage } from "@/lib/storage";
import { Sun } from "@/components/ui/Sun";
import { fraunces } from "@/components/ui/kit";

interface WelcomeProps {
  onComplete: () => void;
}

// The very first screen a new install ever sees — a single tap, no form, no
// tutorial. Tapping sets a default name (editable later in Settings) and
// drops straight into the morning routine.
export function Welcome({ onComplete }: WelcomeProps) {
  const shouldReduce = useReducedMotion() ?? false;
  const [exiting, setExiting] = useState(false);
  const doneRef = useRef(false);

  const go = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    if (!storage.getSettings().userName) {
      storage.setSettings({ userName: "there" });
    }
    setExiting(true);
    setTimeout(onComplete, shouldReduce ? 0 : 420);
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: exiting ? 0 : 1 }}
      transition={{ duration: shouldReduce ? 0 : 0.5, ease: "easeOut" }}
      className="sky fixed inset-0 z-[200] flex flex-col items-center justify-center select-none overflow-hidden"
      style={{ cursor: "pointer" }}
      onClick={go}
    >
      <motion.div
        className="absolute inset-0 pointer-events-none"
        style={{ zIndex: 1, background: "radial-gradient(ellipse 90% 55% at 50% 38%, rgba(255, 208, 120, 0.44) 0%, transparent 68%)" }}
        animate={shouldReduce ? undefined : { opacity: [0.7, 1, 0.7], scale: [1, 1.05, 1] }}
        transition={{ duration: 9, repeat: Infinity, ease: "easeInOut" }}
      />

      <div className="flex flex-col items-center gap-8 relative z-10 px-8">
        <motion.div
          initial={shouldReduce ? undefined : { y: 22, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={shouldReduce ? { duration: 0 } : { duration: 1.4, ease: [0.06, 0.0, 0.05, 1.0] as const }}
        >
          <Sun size={72} beams />
        </motion.div>

        <motion.h1
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: shouldReduce ? 0 : 1.0, delay: shouldReduce ? 0 : 0.5, ease: "easeOut" }}
          className="text-5xl text-center text-[#2A1F18]"
          style={fraunces(300)}
        >
          Welcome to Daybreak.
        </motion.h1>
      </div>

      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.8, delay: 1.6, ease: "easeOut" }}
        className="absolute bottom-16 text-[10px] font-[Inter] font-light tracking-widest uppercase"
        style={{ color: "rgba(107, 85, 68, 0.35)" }}
      >
        press anywhere to start
      </motion.p>
    </motion.div>
  );
}
