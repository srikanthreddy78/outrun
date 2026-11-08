"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { storage } from "@/lib/storage";
import { getTodayKey } from "@/lib/time";

function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function getPast30Days(today: string): string[] {
  const days: string[] = [];
  const base = new Date(today + "T00:00:00");
  for (let i = 29; i >= 0; i--) {
    const d = new Date(base);
    d.setDate(base.getDate() - i);
    days.push(localDateKey(d));
  }
  return days;
}

export function JourneyView() {
  const [completedSet, setCompletedSet] = useState<Set<string>>(new Set());
  const [todayKey] = useState(() => getTodayKey());

  useEffect(() => {
    const dates = storage.getCompletedDates();
    setCompletedSet(new Set(dates));
  }, []);

  const days = getPast30Days(todayKey);
  const completedCount = days.filter((d) => completedSet.has(d)).length;
  const consistency = completedCount / 30;

  const glowRadius = Math.round(20 + consistency * 64);
  const glowOpacity = 0.18 + consistency * 0.55;
  const bloomRadius = Math.round(90 + consistency * 140);
  const bloomOpacity = 0.04 + consistency * 0.26;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5, ease: "easeOut" }}
      className="flex flex-col items-center px-8 pt-14 pb-32 gap-12"
    >
      {/* Sun */}
      <div
        className="relative flex items-center justify-center"
        style={{ width: 220, height: 220 }}
      >
        {/* Bloom */}
        <div
          className="absolute rounded-full pointer-events-none"
          style={{
            width: bloomRadius,
            height: bloomRadius,
            background: `radial-gradient(circle, rgba(245, 178, 32, ${bloomOpacity}) 0%, transparent 70%)`,
          }}
        />
        {/* Sun disc */}
        <div
          style={{
            width: 76,
            height: 76,
            borderRadius: "50%",
            background:
              "radial-gradient(circle at 45% 40%, #F8E090 0%, #F5C078 55%, #EAA060 100%)",
            boxShadow: [
              `0 0 ${glowRadius}px ${Math.round(glowRadius * 0.4)}px rgba(245, 165, 30, ${glowOpacity})`,
              `0 0 ${glowRadius * 2}px ${glowRadius}px rgba(245, 178, 32, ${(glowOpacity * 0.35).toFixed(2)})`,
            ].join(", "),
          }}
        />
      </div>

      {/* Section label */}
      <p
        className="text-[11px] font-[Inter] font-medium uppercase tracking-[0.24em] text-[#4A3728]/70"
        style={{ marginTop: -24 }}
      >
        last 30 mornings
      </p>

      {/* 30-day dot grid — 6 columns × 5 rows */}
      <div
        className="w-full grid gap-2.5"
        style={{ gridTemplateColumns: "repeat(6, 1fr)" }}
      >
        {days.map((day) => {
          const done = completedSet.has(day);
          const isToday = day === todayKey;
          return (
            <div
              key={day}
              style={{
                aspectRatio: "1",
                borderRadius: "50%",
                background: done
                  ? "radial-gradient(circle at 45% 35%, #F8E090 0%, #F5C078 50%, #EAA060 100%)"
                  : "rgba(42, 31, 24, 0.07)",
                boxShadow:
                  done && isToday
                    ? "0 0 8px 3px rgba(245, 165, 30, 0.45)"
                    : done
                    ? "0 0 4px 1px rgba(245, 165, 30, 0.22)"
                    : "none",
              }}
            />
          );
        })}
      </div>

      {completedCount === 0 && (
        <p
          className="text-center text-sm font-[Inter] font-light text-[#4A3728]"
          style={{ opacity: 0.35, fontStyle: "italic" }}
        >
          your mornings will light up here
        </p>
      )}
    </motion.div>
  );
}
