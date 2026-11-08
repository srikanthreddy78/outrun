"use client";

import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { storage } from "@/lib/storage";
import { getDayOfYear, getTodayKey, getYesterdayKey } from "@/lib/time";
import { Sun } from "@/components/ui/Sun";

const TAGLINES = [
  "begin gently.",
  "the day is yours.",
  "a moment before it all begins.",
  "the quiet before the world wakes.",
  "today gets to be different.",
  "one breath at a time.",
  "this is yours.",
  "something good is about to begin.",
  "take it slow.",
  "here is where the day begins.",
];

const RETURN_TAGLINES = [
  "good to have you back.",
  "you came back. that means something.",
  "glad you're here.",
  "the practice waited.",
  "whenever you're ready. here you are.",
  "no matter how long. you're here now.",
];

interface MorningWelcomeProps {
  onComplete: () => void;
}

export function MorningWelcome({ onComplete }: MorningWelcomeProps) {
  const shouldReduce = useReducedMotion() ?? false;
  const [tagline, setTagline] = useState("");
  const [showHint, setShowHint] = useState(false);
  const [exiting, setExiting] = useState(false);
  const doneRef = useRef(false);
  const onCompleteRef = useRef(onComplete);
  useEffect(() => { onCompleteRef.current = onComplete; }, [onComplete]);

  const go = useRef(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    setExiting(true);
  });

  useEffect(() => {
    const completedDates = storage.getCompletedDates();
    const isFirstEver = completedDates.length === 0;
    if (isFirstEver) {
      setTagline("your morning starts here.");
    } else {
      const lastDone = storage.getLastCompletedDate();
      const today = getTodayKey();
      const yesterday = getYesterdayKey();
      const isReturn = lastDone !== null && lastDone !== today && lastDone !== yesterday;
      setTagline(isReturn
        ? RETURN_TAGLINES[getDayOfYear() % RETURN_TAGLINES.length]
        : TAGLINES[getDayOfYear() % TAGLINES.length]
      );
    }
    return () => {};
  }, []);

  useEffect(() => {
    if (!exiting) return;
    const t = setTimeout(() => onCompleteRef.current(), shouldReduce ? 0 : 420);
    return () => clearTimeout(t);
  }, [exiting, shouldReduce]);

  useEffect(() => {
    const t = setTimeout(() => setShowHint(true), 1800);
    return () => clearTimeout(t);
  }, []);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: exiting ? 0 : 1 }}
      transition={{ duration: shouldReduce ? 0 : 0.5, ease: "easeOut" }}
      className="sky fixed inset-0 z-[200] flex flex-col items-center select-none overflow-hidden"
      style={{ cursor: "pointer" }}
      onClick={() => go.current()}
    >
      {/* Ambient glow behind the sun — slowly breathes so the light feels alive */}
      <motion.div
        className="absolute inset-0 pointer-events-none"
        style={{ zIndex: 1, background: "radial-gradient(ellipse 90% 55% at 50% 38%, rgba(255, 208, 120, 0.44) 0%, transparent 68%)" }}
        animate={shouldReduce ? undefined : { opacity: [0.7, 1, 0.7], scale: [1, 1.05, 1] }}
        transition={{ duration: 9, repeat: Infinity, ease: "easeInOut" }}
      />

      <div className="flex flex-col items-center gap-14 relative z-10 px-8 pt-[30vh]">
        {/* Sun */}
        <motion.div
          initial={shouldReduce ? undefined : { y: 22, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={shouldReduce ? { duration: 0 } : { duration: 1.4, ease: [0.06, 0.0, 0.05, 1.0] as const }}
          className="relative flex items-center justify-center"
        >
          {/* gentle perpetual float, layered under the sun's own breathe */}
          <motion.div
            animate={shouldReduce ? undefined : { y: [0, -9, 0] }}
            transition={{ duration: 7, repeat: Infinity, ease: "easeInOut" }}
          >
            <Sun size={72} beams />
          </motion.div>
        </motion.div>

        {/* Tagline */}
        {tagline && (
          <motion.p
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: shouldReduce ? 0 : 1.0, delay: shouldReduce ? 0 : 0.75, ease: "easeOut" }}
            className="text-2xl text-center"
            style={{
              fontFamily: "var(--font-fraunces), Georgia, serif",
              fontWeight: 300,
              fontStyle: "italic",
              color: "rgba(107, 85, 68, 0.6)",
            }}
          >
            {tagline}
          </motion.p>
        )}
      </div>

      {/* Tap hint */}
      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: showHint ? 1 : 0 }}
        transition={{ duration: 0.8, ease: "easeOut" }}
        className="absolute bottom-16 text-[10px] font-[Inter] font-light tracking-widest uppercase"
        style={{ color: "rgba(107, 85, 68, 0.35)" }}
      >
        tap to begin
      </motion.p>
    </motion.div>
  );
}
