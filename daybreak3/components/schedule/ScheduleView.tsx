"use client";

import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { storage } from "@/lib/storage";
import { estimateMinutes } from "@/lib/duration";
import type { Routine, WeekDay, WeekSchedule } from "@/types";

// Sunday-first (S M T W T F S). Two S's / two T's are the standard
// single-letter day labels.
const DAYS: { key: WeekDay; letter: string }[] = [
  { key: "sun", letter: "S" },
  { key: "mon", letter: "M" },
  { key: "tue", letter: "T" },
  { key: "wed", letter: "W" },
  { key: "thu", letter: "T" },
  { key: "fri", letter: "F" },
  { key: "sat", letter: "S" },
];
const DAY_ORDER: WeekDay[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const WEEKDAY_RRULE: Record<WeekDay, string> = {
  mon: "MO", tue: "TU", wed: "WE", thu: "TH", fri: "FR", sat: "SA", sun: "SU",
};

// Quarter-hour increments from 4:00 AM to 11:45 AM.
const TIME_OPTIONS: { label: string; value: string }[] = [];
for (let h = 4; h <= 11; h++) {
  for (let m = 0; m < 60; m += 15) {
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    const ampm = h < 12 ? "AM" : "PM";
    TIME_OPTIONS.push({
      label: `${h12}:${String(m).padStart(2, "0")} ${ampm}`,
      value: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`,
    });
  }
}

function buildGCalUrl(title: string, startTime: string, durationMinutes: number, weekdays: WeekDay[]): string {
  const [hStr, mStr] = startTime.split(":");
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);

  const now = new Date();
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const pad = (n: number) => String(n).padStart(2, "0");

  const startStr = `${y}${mo}${d}T${pad(h)}${pad(m)}00`;
  const endH = h + Math.floor((m + durationMinutes) / 60);
  const endM = (m + durationMinutes) % 60;
  const endStr = `${y}${mo}${d}T${pad(endH % 24)}${pad(endM)}00`;

  const byday = weekdays.map((w) => WEEKDAY_RRULE[w]).join(",");
  const rrule = `RRULE:FREQ=WEEKLY;BYDAY=${byday}`;

  return (
    `https://calendar.google.com/calendar/render?action=TEMPLATE` +
    `&text=${encodeURIComponent(`${title} · Daybreak`)}` +
    `&dates=${startStr}/${endStr}` +
    `&recur=${encodeURIComponent(rrule)}` +
    `&details=${encodeURIComponent(`Daybreak morning routine · est. ${durationMinutes} min`)}`
  );
}

function notificationsOn(): boolean {
  return storage.getSettings().notificationsEnabled !== false;
}

// Re-sync local notifications to the schedule. Respects the global master
// switch — when notifications are off, scheduling is skipped entirely so the
// "off" state stays off no matter what's scheduled here.
async function reschedule(schedule: WeekSchedule, times: Partial<Record<WeekDay, string>>) {
  if (!notificationsOn()) return;
  const { scheduleNotificationsFromSchedule, requestNotificationPermission, checkNotificationPermission } =
    await import("@/lib/notifications");
  if (!(await checkNotificationPermission())) await requestNotificationPermission();
  const { userName } = storage.getSettings();
  await scheduleNotificationsFromSchedule(schedule, times, userName || "");
}

// A schedule block = "run [routine] on [these days] at [this time]". Blocks are
// the editable model; the per-day schedule/times in storage (which notifications
// read) are derived from them.
type Block = { id: string; routineId: string; time: string; days: WeekDay[] };

function uid(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Reconstruct blocks from the per-day storage by grouping scheduled days that
// share the same routine + time.
function blocksFromStorage(schedule: WeekSchedule, times: Partial<Record<WeekDay, string>>): Block[] {
  const map = new Map<string, Block>();
  for (const day of DAY_ORDER) {
    const rid = schedule[day];
    if (!rid) continue;
    const time = times[day] ?? "07:00";
    const key = `${rid}|${time}`;
    if (!map.has(key)) map.set(key, { id: key, routineId: rid, time, days: [] });
    map.get(key)!.days.push(day);
  }
  return [...map.values()];
}

export function ScheduleView() {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [blocks, setBlocks] = useState<Block[]>([]);

  useEffect(() => {
    setRoutines(storage.getRoutines());
    setBlocks(blocksFromStorage(storage.getWeekSchedule(), storage.getScheduleTimes()));
  }, []);

  const customElements = useMemo(() => storage.getCustomElements(), []);

  // Persist a new set of blocks: rebuild the per-day schedule/times in storage,
  // then reschedule notifications. Blocks without an assigned routine or with no
  // days simply don't contribute any scheduled days.
  const persist = (next: Block[]) => {
    setBlocks(next);
    const schedule: WeekSchedule = {};
    const times: Partial<Record<WeekDay, string>> = {};
    for (const day of DAY_ORDER) {
      const b = next.find((bl) => bl.routineId && bl.days.includes(day));
      if (b) {
        schedule[day] = b.routineId;
        times[day] = b.time;
        storage.setDaySchedule(day, b.routineId);
        storage.setScheduleTime(day, b.time);
      } else {
        storage.setDaySchedule(day, null);
      }
    }
    reschedule(schedule, times);
  };

  const addBlock = () => {
    if (routines.length === 0) return;
    persist([...blocks, { id: uid(), routineId: routines[0].id, time: "07:00", days: [] }]);
  };

  const removeBlock = (id: string) => persist(blocks.filter((b) => b.id !== id));

  const setRoutine = (id: string, routineId: string) =>
    persist(blocks.map((b) => (b.id === id ? { ...b, routineId } : b)));

  const setTime = (id: string, time: string) =>
    persist(blocks.map((b) => (b.id === id ? { ...b, time } : b)));

  // Toggling a day on for one block removes it from any other block — a day runs
  // exactly one routine at one time.
  const toggleDay = (id: string, day: WeekDay) =>
    persist(
      blocks.map((b) => {
        if (b.id === id) {
          return b.days.includes(day)
            ? { ...b, days: b.days.filter((d) => d !== day) }
            : { ...b, days: [...b.days, day] };
        }
        return { ...b, days: b.days.filter((d) => d !== day) };
      })
    );

  const toggleEveryDay = (id: string) => {
    const target = blocks.find((b) => b.id === id);
    if (!target) return;
    const allOn = DAY_ORDER.every((d) => target.days.includes(d));
    persist(
      blocks.map((b) => {
        if (b.id === id) return { ...b, days: allOn ? [] : [...DAY_ORDER] };
        // Filling the target's whole week clears those days from every other block.
        return allOn ? b : { ...b, days: [] };
      })
    );
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5, ease: "easeOut" }}
      className="flex flex-col px-6 pb-32 gap-8"
      style={{ paddingTop: "calc(env(safe-area-inset-top) + 3.5rem)" }}
    >
      <div className="flex flex-col gap-5">
        <h2
          className="text-[40px] leading-[1.0] text-[#2A1F18]"
          style={{ fontFamily: "var(--font-fraunces), Georgia, serif", fontWeight: 300 }}
        >
          Schedule.
        </h2>
        <div className="h-px w-full bg-[#2A1F18]/10" />
      </div>

      {routines.length === 0 ? (
        <p className="text-sm font-[Inter] font-light italic" style={{ color: "#4A3728", opacity: 0.5 }}>
          Create a routine first, then add it to your week.
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-4">
            <AnimatePresence initial={false}>
              {blocks.map((block) => {
                const routine = routines.find((r) => r.id === block.routineId);
                const minutes = routine ? estimateMinutes(routine, customElements) : 0;
                const orderedDays = DAY_ORDER.filter((d) => block.days.includes(d));
                const allOn = orderedDays.length === DAY_ORDER.length;

                return (
                  <motion.div
                    key={block.id}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, height: 0, marginBottom: -16 }}
                    transition={{ duration: 0.2, ease: "easeOut" }}
                    className="flex flex-col gap-3.5 p-5 rounded-2xl overflow-hidden"
                    style={{ background: "rgba(42,31,24,0.03)", border: "1px solid rgba(42,31,24,0.06)" }}
                  >
                    {/* Routine + remove */}
                    <div className="flex items-center justify-between gap-3">
                      <div className="relative inline-flex min-w-0">
                        <select
                          value={block.routineId}
                          onChange={(e) => setRoutine(block.id, e.target.value)}
                          className="text-base font-[Inter] cursor-pointer focus:outline-none rounded-full pl-4 pr-9 py-1.5 min-w-0 truncate"
                          style={{
                            fontFamily: "var(--font-fraunces), Georgia, serif",
                            fontWeight: 300,
                            color: "#2A1F18",
                            background: "rgba(42,31,24,0.05)",
                            border: "1px solid rgba(42,31,24,0.09)",
                            appearance: "none",
                          }}
                        >
                          {routines.map((r) => (
                            <option key={r.id} value={r.id}>{r.name}</option>
                          ))}
                        </select>
                        <svg
                          width="11" height="11" viewBox="0 0 11 11" fill="none"
                          stroke="#2A1F18" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"
                          className="absolute right-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
                          style={{ opacity: 0.4 }}
                        >
                          <polyline points="2,3.5 5.5,7 9,3.5" />
                        </svg>
                      </div>
                      <button
                        onClick={() => removeBlock(block.id)}
                        className="text-sm font-[Inter] font-light transition-opacity shrink-0 hover:opacity-90"
                        style={{ color: "#4A3728", opacity: 0.4 }}
                        aria-label="Remove from week"
                      >
                        ✕
                      </button>
                    </div>

                    {/* Seven-circle day picker */}
                    <div className="flex items-center justify-between">
                      {DAYS.map(({ key, letter }) => {
                        const on = block.days.includes(key);
                        return (
                          <button
                            key={key}
                            onClick={() => toggleDay(block.id, key)}
                            className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-[Inter] transition-colors"
                            style={{
                              background: on ? "#2A1F18" : "transparent",
                              border: on ? "1px solid #2A1F18" : "1px solid rgba(42,31,24,0.15)",
                              color: on ? "#F5E6C8" : "#4A3728",
                              opacity: on ? 1 : 0.65,
                              fontWeight: on ? 500 : 400,
                            }}
                          >
                            {letter}
                          </button>
                        );
                      })}
                    </div>

                    {/* Time + every-day + export */}
                    <div className="flex items-center justify-between gap-3 pt-0.5">
                      <div className="flex items-center gap-3">
                        <div className="relative inline-flex">
                          <select
                            value={block.time}
                            onChange={(e) => setTime(block.id, e.target.value)}
                            className="text-xs font-[Inter] font-light cursor-pointer focus:outline-none rounded-full pl-3 pr-7 py-1.5"
                            style={{
                              color: "#2A1F18",
                              background: "rgba(42,31,24,0.05)",
                              border: "1px solid rgba(42,31,24,0.09)",
                              appearance: "none",
                            }}
                          >
                            {TIME_OPTIONS.map((opt) => (
                              <option key={opt.value} value={opt.value}>{opt.label}</option>
                            ))}
                          </select>
                          <svg
                            width="9" height="9" viewBox="0 0 11 11" fill="none"
                            stroke="#2A1F18" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"
                            className="absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
                            style={{ opacity: 0.4 }}
                          >
                            <polyline points="2,3.5 5.5,7 9,3.5" />
                          </svg>
                        </div>
                        <button
                          onClick={() => toggleEveryDay(block.id)}
                          className="text-xs font-[Inter] font-light transition-opacity hover:opacity-100"
                          style={{ color: "#4A3728", opacity: 0.5 }}
                        >
                          {allOn ? "clear" : "every day"}
                        </button>
                      </div>
                      {orderedDays.length > 0 && routine && (
                        <a
                          href={buildGCalUrl(routine.name, block.time, minutes, orderedDays)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs font-[Inter] font-light transition-opacity shrink-0"
                          style={{ color: "#4A3728", opacity: 0.5 }}
                          onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.85")}
                          onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.5")}
                        >
                          add to Google →
                        </a>
                      )}
                    </div>
                  </motion.div>
                );
              })}
            </AnimatePresence>

            <button
              onClick={addBlock}
              className="self-start text-sm font-[Inter] font-light transition-opacity hover:opacity-100"
              style={{ color: "#4A3728", opacity: 0.55 }}
            >
              + add to your week
            </button>
          </div>

          <p className="text-xs font-[Inter] font-light leading-relaxed" style={{ color: "#4A3728", opacity: 0.4 }}>
            Each block notifies you at its set time. Adding to Google Calendar is optional — it just copies the block to your calendar.
          </p>
        </>
      )}
    </motion.div>
  );
}
