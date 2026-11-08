"use client";

import { useEffect, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { motion } from "framer-motion";
import { storage } from "@/lib/storage";
import { getTodayKey } from "@/lib/time";
import type { DayKey } from "@/types";

type Entry = {
  date: DayKey;
  dayLabel: string;
  dateLabel: string;
  intention: string;
  gratitude: string;
  notes: string;
};

function isValidDateKey(key: string): boolean {
  const d = new Date(key + "T00:00:00");
  return !isNaN(d.getTime());
}

function formatLabels(key: DayKey): { dayLabel: string; dateLabel: string } {
  const d = new Date(key + "T00:00:00");
  return {
    dayLabel: d.toLocaleDateString("en-US", { weekday: "short" }),
    dateLabel: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
  };
}

export function PastMornings() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const today = getTodayKey();
    const dates = storage
      .getCompletedDates()
      .filter((d) => d !== today && isValidDateKey(d))
      .sort((a, b) => b.localeCompare(a))
      .slice(0, 7);

    setEntries(
      dates.map((date) => {
        const { dayLabel, dateLabel } = formatLabels(date);
        return {
          date,
          dayLabel,
          dateLabel,
          intention: storage.getIntention(date),
          gratitude: storage.getGratitudeEntry(date),
          notes: storage.getJournalEntry(date),
        };
      })
    );
  }, []);

  if (entries.length === 0) return null;

  return (
    <div className="flex flex-col gap-4">
      {/* Section header */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-3 w-full cursor-pointer group"
      >
        <p
          className="text-xs font-[Inter] tracking-widest uppercase shrink-0 text-[#4A3728] opacity-40 group-active:opacity-65 transition-opacity duration-150"
        >
          past mornings
        </p>
        <div className="flex-1" style={{ height: 1, background: "rgba(42,31,24,0.07)" }} />
        <svg
          width="11" height="11" viewBox="0 0 10 10" fill="none"
          stroke="#4A3728" strokeWidth="1.6" strokeLinecap="round"
          className="opacity-45 group-active:opacity-70 transition-opacity duration-150 shrink-0"
          style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s ease, opacity 0.15s ease" }}
        >
          <polyline points="1.5,3 5,7 8.5,3" />
        </svg>
      </button>

      {/* Rows */}
      <AnimatePresence initial={false}>
      {open && <motion.div
        initial={{ height: 0, opacity: 0 }}
        animate={{ height: "auto", opacity: 1 }}
        exit={{ height: 0, opacity: 0 }}
        transition={{ duration: 0.22, ease: "easeOut" }}
        className="overflow-hidden"
      >
      <div className="flex flex-col">
        {entries.map((entry, idx) => (
          <motion.div
            key={entry.date}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.06 * idx, ease: "easeOut" }}
          >
            <div className="py-4 flex gap-4">
              {/* Date column */}
              <div className="shrink-0 w-10 flex flex-col items-start pt-0.5">
                <p className="text-xs font-[Inter] font-light" style={{ color: "#4A3728", opacity: 0.55 }}>
                  {entry.dayLabel}
                </p>
                <p className="text-[10px] font-[Inter] font-light" style={{ color: "#4A3728", opacity: 0.3 }}>
                  {entry.dateLabel}
                </p>
              </div>

              {/* Content */}
              <div className="flex-1 flex flex-col gap-1.5">
                {entry.intention ? (
                  <p
                    className="text-sm leading-snug text-[#2A1F18]"
                    style={{ fontFamily: "var(--font-fraunces), Georgia, serif", fontWeight: 300 }}
                  >
                    {entry.intention}
                  </p>
                ) : (
                  <p
                    className="text-sm leading-snug"
                    style={{ fontFamily: "var(--font-fraunces), Georgia, serif", fontWeight: 300, fontStyle: "italic", color: "#4A3728", opacity: 0.25 }}
                  >
                    no intention
                  </p>
                )}
                {entry.gratitude && (
                  <p className="text-xs font-[Inter] font-light leading-snug" style={{ color: "#4A3728", opacity: 0.5 }}>
                    {entry.gratitude}
                  </p>
                )}
                {entry.notes && !entry.gratitude && (
                  <p className="text-xs font-[Inter] font-light leading-snug" style={{ color: "#4A3728", opacity: 0.5 }}>
                    {entry.notes}
                  </p>
                )}
              </div>
            </div>

            {idx < entries.length - 1 && (
              <div style={{ height: 1, background: "rgba(42,31,24,0.05)" }} />
            )}
          </motion.div>
        ))}
      </div>
      </motion.div>}
      </AnimatePresence>
    </div>
  );
}
