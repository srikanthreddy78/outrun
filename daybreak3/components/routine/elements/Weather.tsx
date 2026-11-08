"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { getWeatherForToday, getLastWeather } from "@/lib/weather";
import { Button } from "@/components/ui/Button";
import type { WeatherData } from "@/types";


type Status = "loading" | "ready" | "unavailable";

interface WeatherProps {
  onNext: () => void;
  onSkip: () => void;
}

export function Weather({ onNext, onSkip }: WeatherProps) {
  const [status, setStatus] = useState<Status>("loading");
  const [weatherData, setWeatherData] = useState<WeatherData | null>(null);

  useEffect(() => {
    // Show the last cached reading instantly (even if it's from a prior day),
    // then refresh in the background so there's no blank delay on open.
    const last = getLastWeather();
    if (last) {
      setWeatherData(last);
      setStatus("ready");
    }
    // getWeatherForToday() approximates location from IP when none is stored
    // (racing several providers so one rate-limit doesn't slow it), so weather
    // appears automatically — no permission prompt or tap-to-enable needed.
    getWeatherForToday().then((data) => {
      if (data) {
        setWeatherData(data);
        setStatus("ready");
      } else if (!last) {
        setStatus("unavailable");
      }
    });
  }, []);

  return (
    <div className="flex flex-col items-center justify-start min-h-full pt-[28vh] px-8 text-center gap-12">
      <div className="flex flex-col items-center gap-6">
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5 }}
          className="text-[11px] font-[Inter] font-medium uppercase tracking-[0.24em] text-[#4A3728]/70"
        >
          outside
        </motion.p>

        <AnimatePresence mode="wait">
          {status === "loading" && (
            <motion.div
              key="loading"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              style={{ height: 112 }}
            />
          )}

          {status === "ready" && weatherData && (
            <motion.div
              key="ready"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, ease: "easeOut" }}
              className="flex flex-col items-center gap-3"
            >
              <p
                className="text-8xl text-[#2A1F18] leading-none"
                style={{ fontFamily: "var(--font-fraunces), Georgia, serif", fontWeight: 300 }}
              >
                {weatherData.temp}°
              </p>
              <p
                className="text-xl text-[#4A3728]/75"
                style={{ fontFamily: "var(--font-fraunces), Georgia, serif", fontWeight: 300 }}
              >
                {weatherData.description} · feels {weatherData.feelsLike}°
              </p>
              <p className="text-sm text-[#4A3728] font-[Inter] opacity-55">
                ↑ {weatherData.high}° · ↓ {weatherData.low}°
                {weatherData.rainChance != null &&
                  ` · ${weatherData.rainChance}% rain ${weatherData.rainTimeLabel}`}
              </p>
            </motion.div>
          )}

          {status === "unavailable" && (
            <motion.div
              key="unavailable"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.5 }}
            >
              <p
                className="text-[#4A3728]/40 text-sm font-[Inter] font-light"
                style={{ height: 112, display: "flex", alignItems: "center" }}
              >
                weather unavailable — enable in settings
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="flex flex-col items-center gap-4">
        <Button onClick={onNext}>Continue</Button>
        <Button variant="ghost" onClick={onSkip}>skip</Button>
      </div>
    </div>
  );
}
