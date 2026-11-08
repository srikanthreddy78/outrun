"use client";

import { motion } from "framer-motion";

/**
 * The app's sun mark — a radiant luminous orb: a hot white centre blooming into
 * warm gold with a soft edge (reads as light, not a flat disc), a breathing
 * corona ring, ambient glow, and optional rings that pulse outward. Size-
 * parametrized so it reads the same everywhere (welcome, onboarding, tour…).
 *
 * Entrance animation belongs to the parent; this owns the perpetual
 * breathe/shimmer. Turn `glow`/`ring` off where a surface supplies its own
 * bloom; `beams` on for focal centrepieces.
 */
export function Sun({
  size = 72,
  glow = true,
  ring = true,
  beams = false,
  className = "",
}: {
  size?: number;
  glow?: boolean;
  ring?: boolean;
  beams?: boolean;
  className?: string;
}) {
  return (
    <div className={`relative flex items-center justify-center ${className}`}>
      {glow && (
        <div
          aria-hidden
          className="absolute rounded-full pointer-events-none"
          style={{
            width: size * 3.6,
            height: size * 3.6,
            background: "radial-gradient(circle, rgba(255,196,70,0.16) 0%, transparent 60%)",
          }}
        />
      )}
      {/* Rings pulsing outward from the sun like ripples in a pond — fade in as
          they start, expand all the way past the screen edge, fade out. The
          opacity ramps [0 → peak → 0] (no hard snap) so there's no bright flash
          at the start of each cycle. */}
      {beams &&
        [0, 1].map((i) => (
          <motion.div
            key={i}
            aria-hidden
            className="absolute rounded-full pointer-events-none"
            style={{
              width: size * 2.2,
              height: size * 2.2,
              // soft diffuse halo (not a crisp line) so it reads as ambient
              // light rather than a hypnotic sonar ring — but visible
              background:
                "radial-gradient(circle, transparent 44%, rgba(255,226,158,0.95) 60%, transparent 80%)",
            }}
            initial={{ scale: 1, opacity: 0 }}
            animate={{ scale: [1, 6], opacity: [0, 0.24, 0] }}
            transition={{
              duration: 15,
              repeat: Infinity,
              ease: "easeOut",
              times: [0, 0.15, 1],
              delay: i * 8,
            }}
          />
        ))}
      {ring && (
        <motion.div
          aria-hidden
          className="absolute rounded-full pointer-events-none"
          style={{
            width: size * 1.46,
            height: size * 1.46,
            border: "1px solid rgba(255,214,120,0.45)",
          }}
          animate={{ scale: [1, 1.08, 1], opacity: [0.5, 0.22, 0.5] }}
          transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
        />
      )}
      {/* Core: hot white centre → gold → soft translucent rim, so the edge blooms
          instead of reading as a hard geometric circle. Strong luminous shadow. */}
      <motion.div
        className="relative rounded-full"
        style={{
          width: size,
          height: size,
          background:
            "radial-gradient(circle at 50% 44%, #FFFFFF 0%, #FFF7D2 26%, #FFDC66 55%, #FCB833 80%, rgba(245,152,22,0.85) 100%)",
          boxShadow: `0 0 ${size * 0.5}px ${size * 0.2}px rgba(255,214,90,0.6), 0 0 ${size * 1.1}px ${size * 0.42}px rgba(248,168,40,0.4), 0 0 ${size * 2}px ${size * 0.8}px rgba(245,160,30,0.18)`,
        }}
        animate={{ scale: [1, 1.07, 1] }}
        transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
      >
        {/* hot white centre bloom — the "too bright to look at" point */}
        <motion.div
          aria-hidden
          className="absolute rounded-full pointer-events-none"
          style={{
            left: "50%",
            top: "44%",
            width: size * 0.62,
            height: size * 0.62,
            transform: "translate(-50%, -50%)",
            background: "radial-gradient(circle, rgba(255,255,255,0.95) 0%, rgba(255,255,255,0) 70%)",
          }}
          animate={{ opacity: [0.85, 1, 0.85] }}
          transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
        />
      </motion.div>
    </div>
  );
}
