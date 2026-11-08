"use client";

import { motion, useReducedMotion } from "framer-motion";

interface FillingCircleProps {
  progress: number; // 0 → 1
  size?: number;
}

export function FillingCircle({ progress, size = 120 }: FillingCircleProps) {
  const shouldReduce = useReducedMotion() ?? false;
  const clampedProgress = Math.min(1, Math.max(0, progress));

  return (
    <div style={{ width: size, height: size, position: "relative", flexShrink: 0 }}>
      {/* Faint outline */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: "50%",
          border: "1px solid rgba(42,31,24,0.08)",
        }}
      />
      {/* Filling disc — grows from center via scale */}
      <motion.div
        style={{
          position: "absolute",
          inset: 8,
          borderRadius: "50%",
          backgroundColor: "rgba(245, 200, 120, 0.42)",
          transformOrigin: "center",
          scale: 0,
        }}
        animate={{ scale: clampedProgress }}
        transition={
          shouldReduce
            ? { duration: 0 }
            : { duration: 1, ease: "linear" }
        }
      />
    </div>
  );
}
