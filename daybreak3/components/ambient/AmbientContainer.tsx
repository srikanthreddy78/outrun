"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { storage } from "@/lib/storage";
import { getGreeting, getTodayKey, getDayOfYear } from "@/lib/time";
import { getWeatherForToday, getLastWeather } from "@/lib/weather";
import quotes from "@/lib/quotes.json";
import type { WeatherData } from "@/types";
import { PastMornings } from "./PastMornings";
import { fraunces, Label, Rule, CircleButton } from "@/components/ui/kit";
import { playTap } from "@/lib/audio";
import { hapticLight } from "@/lib/haptics";

interface AmbientContainerProps {
  onStartRoutine: () => void;
}

const todaysQuote = quotes[getDayOfYear() % quotes.length];

// The ambient screen is the resting form of the active routine — each module
// that has something to "carry" through the day renders here, in the same
// order it appears in the routine. Modules with no resting form (breathe,
// water, exercise, timers…) simply don't contribute a section.
type Section =
  | { kind: "intention"; value: string | null }
  | { kind: "gratitude"; value: string | null }
  | { kind: "weather" }
  | { kind: "quote" }
  | { kind: "prompt"; id: string; label: string; emoji?: string; value: string | null };

// Shared label + written-value (or placeholder) block used by intention,
// gratitude, and custom prompts. Tiny tracked label over a serif value —
// the editorial type grid.
function TextSection({ label, value, placeholder }: { label: string; value: string | null; placeholder: string }) {
  return (
    <div className="flex flex-col gap-2.5">
      <Label>{label}</Label>
      {value ? (
        <p className="text-[#2A1F18] text-[22px] leading-snug w-full break-words" style={fraunces(300)}>
          {value}
        </p>
      ) : (
        <p className="text-[#4A3728] text-[19px] leading-snug opacity-45" style={fraunces(300, true)}>
          {placeholder}
        </p>
      )}
    </div>
  );
}

export function AmbientContainer({ onStartRoutine }: AmbientContainerProps) {
  const router = useRouter();
  const [greeting, setGreeting] = useState("");
  const [sections, setSections] = useState<Section[]>([]);
  const [weather, setWeather] = useState<WeatherData | null>(null);

  useEffect(() => {
    const { userName } = storage.getSettings();
    setGreeting(getGreeting(userName || ""));

    const routine = storage.getRoutine(storage.getActiveRoutineId());
    if (!routine) return;

    const customElements = storage.getCustomElements();
    const today = getTodayKey();
    const seen = new Set<string>();
    const built: Section[] = [];

    // Walk the routine in order, mapping each element to its resting section.
    // Built-ins appear at most once; custom prompts dedupe by element id.
    for (const el of routine.elements) {
      if (el.type === "intention" && !seen.has("intention")) {
        seen.add("intention");
        built.push({ kind: "intention", value: storage.getIntention(today) || null });
      } else if (el.type === "gratitude" && !seen.has("gratitude")) {
        seen.add("gratitude");
        built.push({ kind: "gratitude", value: storage.getGratitudeEntry(today) || null });
      } else if (el.type === "weather" && !seen.has("weather")) {
        seen.add("weather");
        built.push({ kind: "weather" });
      } else if (el.type === "quote" && !seen.has("quote")) {
        seen.add("quote");
        built.push({ kind: "quote" });
      } else if (el.type === "custom" && el.customElementId) {
        const c = customElements.find((x) => x.id === el.customElementId);
        if (c && c.type === "prompt" && !seen.has(c.id)) {
          seen.add(c.id);
          built.push({
            kind: "prompt",
            id: c.id,
            label: c.label,
            emoji: c.emoji,
            value: storage.getCustomElementEntry(c.id, today) || null,
          });
        }
      }
    }

    setSections(built);

    // Weather lingers on the main screen now (it used to vanish after the
    // routine). Show the last cached reading instantly, then refresh in the
    // background so it doesn't pop in after a delay.
    if (built.some((s) => s.kind === "weather")) {
      const last = getLastWeather();
      if (last) setWeather(last);
      getWeatherForToday().then((d) => { if (d) setWeather(d); });
    }
  }, []);

  // "good evening, matthew." → lead "good evening," + name "matthew."
  const commaIndex = greeting.indexOf(", ");
  const greetingLead = commaIndex !== -1 ? greeting.slice(0, commaIndex + 1) : "";
  const greetingName = commaIndex !== -1 ? greeting.slice(commaIndex + 2) : greeting;

  // Resting-form sections, rendered in routine order and separated by hairlines.
  const rendered = sections
    .map((section, i) => {
      switch (section.kind) {
        case "intention":
          return <TextSection key="intention" label="today is for" value={section.value} placeholder="what's today for?" />;
        case "gratitude":
          return <TextSection key="gratitude" label="grateful for" value={section.value} placeholder="one thing worth holding." />;
        case "prompt":
          return (
            <TextSection
              key={section.id}
              label={section.emoji ? `${section.label} ${section.emoji}` : section.label}
              value={section.value}
              placeholder="nothing yet."
            />
          );
        case "weather":
          return weather ? (
            <div key="weather" className="flex items-end justify-between">
              <div className="flex flex-col gap-2.5">
                <Label>outside</Label>
                <p className="text-[15px] text-[#4A3728] leading-snug" style={fraunces(300, true)}>
                  {weather.description}
                </p>
              </div>
              <p className="text-[34px] leading-none text-[#2A1F18]" style={fraunces(300)}>
                {weather.temp}°
              </p>
            </div>
          ) : null;
        case "quote":
          return (
            <div key={`quote-${i}`} className="flex flex-col gap-3">
              <span
                className="-mb-6 select-none text-[64px] leading-none text-[#2A1F18]/15"
                style={fraunces(400)}
              >
                &ldquo;
              </span>
              <blockquote
                className="pl-1 text-[21px] leading-relaxed text-[#2A1F18]"
                style={fraunces(300, true)}
              >
                {todaysQuote.text}
              </blockquote>
              <p className="pl-1 text-[11px] font-[Inter] uppercase tracking-[0.22em] text-[#4A3728]/70">
                {todaysQuote.author}
              </p>
            </div>
          );
      }
    })
    .filter(Boolean);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.6, ease: "easeOut" }}
      className="flex flex-col px-8 pt-24 pb-32 max-w-sm mx-auto gap-9"
      // Soft warm-white halo behind all text — invisible on the light sky, but
      // lifts text off darker/busier patches (dawn palette, passing clouds) so
      // it stays legible as the atmosphere drifts and shifts by time of day.
      style={{ textShadow: "0 1px 16px rgba(255,248,232,0.55)" }}
    >
      {/* Masthead: greeting large + commanding, settings gear in the corner */}
      <div className="flex flex-col gap-5">
        <div className="flex items-start justify-between">
          <div className="flex flex-col gap-1">
            {greetingLead && (
              <p className="text-[15px] text-[#4A3728]" style={fraunces(300, true)}>
                {greetingLead}
              </p>
            )}
            <h1 className="-mt-0.5 text-[40px] leading-[1.0] text-[#2A1F18]" style={fraunces(300)}>
              {greetingName}
            </h1>
          </div>
          <button
            onClick={() => router.push("/settings")}
            className="text-[#4A3728] opacity-70 active:opacity-90 transition-opacity cursor-pointer shrink-0 -mr-2 mt-1 p-2"
            aria-label="Settings"
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 18 18"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="9" cy="9" r="2.5" />
              <path d="M9 1.5v1.3M9 15.2v1.3M1.5 9h1.3M15.2 9h1.3M3.7 3.7l.9.9M13.4 13.4l.9.9M3.7 14.3l.9-.9M13.4 4.6l.9-.9" />
            </svg>
          </button>
        </div>
        <Rule />
      </div>

      {/* Routine modules, in order, hairline-separated */}
      {rendered.map((node, i) => (
        <div key={i} className="flex flex-col gap-9">
          {node}
          {i < rendered.length - 1 && <Rule />}
        </div>
      ))}

      {rendered.length > 0 && <Rule />}

      {/* Past mornings */}
      <PastMornings />

      {/* Revisit (cream FAB) + footer */}
      <div className="mt-auto flex flex-col gap-8 pt-4">
        <div className="flex items-center gap-4">
          <CircleButton onClick={() => { playTap(); hapticLight(); onStartRoutine(); }} ariaLabel="revisit this morning" />
          <span className="text-sm font-[Inter] text-[#4A3728]/70">revisit this morning</span>
        </div>
        <button
          onClick={() => router.push("/about")}
          className="self-start text-xs font-[Inter] text-[#4A3728] opacity-45 active:opacity-70 transition-opacity cursor-pointer"
        >
          about Daybreak ✦
        </button>
      </div>
    </motion.div>
  );
}
