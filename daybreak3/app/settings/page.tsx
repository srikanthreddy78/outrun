"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { storage } from "@/lib/storage";
import {
  requestNotificationPermission,
  cancelMorningNotifications,
  scheduleNotificationsFromSchedule,
} from "@/lib/notifications";
import { Rule } from "@/components/ui/kit";
import { hapticLight } from "@/lib/haptics";
import { playToggle, playConfirm } from "@/lib/audio";

type LocStatus = "idle" | "loading" | "granted" | "denied";

export default function Settings() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [city, setCity] = useState<string | null>(null);
  const [locStatus, setLocStatus] = useState<LocStatus>("idle");
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [hapticsEnabled, setHapticsEnabled] = useState(true);
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);

  useEffect(() => {
    const settings = storage.getSettings();
    setName(settings.userName);
    setSoundEnabled(settings.soundEnabled ?? true);
    setHapticsEnabled(settings.hapticsEnabled ?? true);
    setNotificationsEnabled(settings.notificationsEnabled !== false);
    if (settings.location) {
      setCity(settings.location.city);
      setLocStatus("granted");
    }
  }, []);

  const toggleSound = () => {
    const next = !soundEnabled;
    setSoundEnabled(next);
    storage.setSettings({ soundEnabled: next });
    // Gate reads the value we just wrote, so turning off stays silent.
    playToggle();
    hapticLight();
  };

  const toggleHaptics = () => {
    const next = !hapticsEnabled;
    setHapticsEnabled(next);
    storage.setSettings({ hapticsEnabled: next });
    playToggle();
    // Fire a confirming tap only when turning on (the gate reads the value we
    // just wrote, so turning off stays silent).
    if (next) hapticLight();
  };

  // Global master switch. On → request permission and schedule from the current
  // week. Off → cancel everything and stay off (the scheduler also checks this
  // flag, so assigning days won't bring notifications back).
  const toggleNotifications = async () => {
    const next = !notificationsEnabled;
    setNotificationsEnabled(next);
    storage.setSettings({ notificationsEnabled: next });
    playToggle();
    if (next) {
      await requestNotificationPermission();
      const { userName } = storage.getSettings();
      await scheduleNotificationsFromSchedule(storage.getWeekSchedule(), storage.getScheduleTimes(), userName || "");
    } else {
      await cancelMorningNotifications();
    }
  };

  const handleLocation = () => {
    if (!navigator.geolocation) {
      setLocStatus("denied");
      return;
    }
    setLocStatus("loading");
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude: lat, longitude: lng } = pos.coords;
        let resolvedCity = "your location";
        try {
          const res = await fetch(
            `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`,
            { headers: { "Accept-Language": "en" } }
          );
          const data = await res.json();
          const raw =
            data.address?.city ||
            data.address?.town ||
            data.address?.village ||
            data.address?.county ||
            resolvedCity;
          resolvedCity = /^[\w\s\-',\.]+$/.test(raw) ? raw : resolvedCity;
        } catch {
          // use fallback
        }
        setCity(resolvedCity);
        setLocStatus("granted");
        storage.setSettings({ location: { lat, lng, city: resolvedCity } });
      },
      () => setLocStatus("denied")
    );
  };

  const handleRemoveLocation = () => {
    storage.setSettings({ location: null });
    storage.clearCachedWeather();
    setCity(null);
    setLocStatus("idle");
  };

  const handleSave = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    storage.setSettings({ userName: trimmed });
    playConfirm();
    hapticLight();
    router.push("/");
  };

  return (
    <main className="dawn-gradient min-h-screen w-full flex items-stretch justify-center">
      <div className="w-full max-w-[600px] mx-auto flex flex-col px-8 py-16">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: "easeOut" }}
          className="flex flex-col gap-12"
        >
          {/* Back */}
          <button
            onClick={() => { hapticLight(); router.back(); }}
            className="self-start text-sm font-[Inter] font-light transition-opacity"
            style={{ color: "#4A3728", opacity: 0.45 }}
            onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.75")}
            onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.45")}
          >
            ← back
          </button>

          {/* Heading */}
          <div className="flex flex-col gap-5">
            <h1
              className="text-[40px] leading-[1.0] text-[#2A1F18]"
              style={{ fontFamily: "var(--font-fraunces), Georgia, serif", fontWeight: 300 }}
            >
              Settings
            </h1>
            <Rule />
          </div>

          {/* Form */}
          <div className="flex flex-col gap-8">
            {/* Name */}
            <div className="flex flex-col gap-3">
              <label
                htmlFor="name"
                className="text-[11px] font-[Inter] font-medium uppercase tracking-[0.24em] text-[#4A3728]/70"
              >
                Your name
              </label>
              <input
                id="name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSave()}
                placeholder="First name is fine"
                className="w-full bg-[#2A1F18]/5 border border-[#2A1F18]/10 rounded-full px-6 py-3.5 text-[#2A1F18] text-base font-[Inter] font-light focus:outline-none hover:border-[#2A1F18]/20 hover:bg-[#2A1F18]/[0.08] focus:border-[#2A1F18]/25 placeholder:text-[#4A3728]/40 transition-colors"
              />
            </div>

            {/* Location */}
            <div className="flex flex-col gap-3">
              <p className="text-[11px] font-[Inter] font-medium uppercase tracking-[0.24em] text-[#4A3728]/70">
                Location
              </p>
              {locStatus === "granted" && city ? (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-3">
                    <input
                      type="text"
                      value={city}
                      onChange={(e) => {
                        const newCity = e.target.value;
                        setCity(newCity);
                        const loc = storage.getSettings().location;
                        if (loc) storage.setSettings({ location: { ...loc, city: newCity } });
                        const cached = storage.getCachedWeather();
                        if (cached) storage.setCachedWeather(cached.date, { ...cached.data, city: newCity });
                      }}
                      className="flex-1 bg-[#2A1F18]/5 border border-[#2A1F18]/10 rounded-full px-6 py-3.5 text-[#2A1F18] text-base font-[Inter] font-light focus:outline-none hover:border-[#2A1F18]/20 hover:bg-[#2A1F18]/[0.08] focus:border-[#2A1F18]/25 transition-colors"
                    />
                    <button
                      onClick={handleLocation}
                      className="text-[#4A3728] text-sm font-[Inter] opacity-50 hover:opacity-80 transition-opacity shrink-0"
                    >
                      re-detect
                    </button>
                    <button
                      onClick={handleRemoveLocation}
                      className="text-[#4A3728] text-sm font-[Inter] opacity-50 hover:opacity-80 transition-opacity shrink-0"
                    >
                      remove
                    </button>
                  </div>
                  <p className="text-[#4A3728] text-xs font-[Inter] font-light opacity-50 px-2">
                    Edit if the city name looks wrong.
                  </p>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <button
                    onClick={handleLocation}
                    disabled={locStatus === "loading"}
                    className="w-full bg-[#2A1F18]/5 border border-[#2A1F18]/10 rounded-full px-6 py-3.5 text-[#2A1F18] text-base font-[Inter] font-light hover:bg-[#2A1F18]/10 transition-colors disabled:opacity-50 text-left"
                  >
                    {locStatus === "loading" ? "Locating…" : "Allow location access"}
                  </button>
                  {locStatus === "denied" && (
                    <p className="text-[#4A3728] text-sm font-[Inter] font-light px-2">
                      Location access was denied. Weather will be unavailable.
                    </p>
                  )}
                  <p className="text-[#4A3728] text-xs font-[Inter] font-light opacity-60 px-2">
                    Requested only after you tap this button. Coordinates are stored on this device and sent to Open-Meteo and OpenStreetMap&apos;s Nominatim only to show local weather and a city label.
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Toggles — Open-style hairline list rows */}
          <div className="flex flex-col gap-6">
            {/* Notifications — global master switch (per-day times live in the Scheduler) */}
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-[Inter] font-medium uppercase tracking-[0.24em] text-[#4A3728]/70">
                Notifications
              </p>
              <button
                onClick={toggleNotifications}
                className={`text-sm font-[Inter] font-light transition-opacity cursor-pointer hover:opacity-100 ${notificationsEnabled ? "opacity-70" : "opacity-[0.35]"}`}
                style={{ color: "#4A3728" }}
              >
                {notificationsEnabled ? "on" : "off"}
              </button>
            </div>

            <Rule />

            {/* Sounds */}
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-[Inter] font-medium uppercase tracking-[0.24em] text-[#4A3728]/70">
                Sounds
              </p>
              <button
                onClick={toggleSound}
                className={`text-sm font-[Inter] font-light transition-opacity cursor-pointer hover:opacity-100 ${soundEnabled ? "opacity-70" : "opacity-[0.35]"}`}
                style={{ color: "#4A3728" }}
              >
                {soundEnabled ? "on" : "off"}
              </button>
            </div>

            <Rule />

            {/* Haptics */}
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-[Inter] font-medium uppercase tracking-[0.24em] text-[#4A3728]/70">
                Haptics
              </p>
              <button
                onClick={toggleHaptics}
                className={`text-sm font-[Inter] font-light transition-opacity cursor-pointer hover:opacity-100 ${hapticsEnabled ? "opacity-70" : "opacity-[0.35]"}`}
                style={{ color: "#4A3728" }}
              >
                {hapticsEnabled ? "on" : "off"}
              </button>
            </div>
          </div>

          {/* Save */}
          <motion.button
            onClick={handleSave}
            whileTap={{ scale: 0.97 }}
            disabled={!name.trim()}
            className="self-start px-8 py-3 rounded-full border border-[#2A1F18]/20 text-[#2A1F18] text-sm font-[Inter] font-medium tracking-wide bg-[#2A1F18]/5 hover:bg-[#2A1F18]/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
          >
            Save
          </motion.button>
        </motion.div>
      </div>
    </main>
  );
}
