"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { getMode } from "@/lib/mode";
import { storage } from "@/lib/storage";
import { getTodayKey } from "@/lib/time";
import { scheduleNotificationsFromSchedule } from "@/lib/notifications";
import { RoutineContainer } from "@/components/routine/RoutineContainer";
import { AmbientContainer } from "@/components/ambient/AmbientContainer";
import { TabBar, type Tab } from "@/components/tabs/TabBar";
import { ScheduleView } from "@/components/schedule/ScheduleView";
import { RoutinesList } from "@/components/routines/RoutinesList";
import { RoutineBuilder } from "@/components/builder/RoutineBuilder";
import { Welcome } from "@/components/Welcome";
import { MorningWelcome } from "@/components/MorningWelcome";

type ViewMode = "loading" | "welcome" | "morning-welcome" | "routine" | "tabs";

const tabFade = {
  enter: { opacity: 0 },
  center: { opacity: 1 },
  exit: { opacity: 0 },
};

export default function Home() {
  const [mode, setMode] = useState<ViewMode>("loading");
  const [activeTab, setActiveTab] = useState<Tab>("today");
  const [editingRoutineId, setEditingRoutineId] = useState<string | null>(null);

  useEffect(() => {
    const appMode = getMode();
    if (appMode === "settings") {
      setMode("welcome");
      return;
    }
    setMode(appMode === "routine" ? "morning-welcome" : "tabs");

    // Re-assert weekly-repeating notifications on launch, gated on the master
    // switch — keeps them synced to the current schedule. Fire-and-forget.
    const settings = storage.getSettings();
    const weekSchedule = storage.getWeekSchedule();
    if (settings.notificationsEnabled !== false && Object.keys(weekSchedule).length > 0) {
      scheduleNotificationsFromSchedule(weekSchedule, storage.getScheduleTimes(), settings.userName || "");
    }
  }, []);

  const handleWelcomeComplete = () => setMode("routine");
  const handleMorningWelcomeComplete = () => setMode("routine");

  const handleRoutineComplete = () => {
    storage.setLastCompletedDate(getTodayKey());
    setMode("tabs");
    setActiveTab("today");
  };

  const handleStartRoutine = () => setMode("routine");

  if (mode === "loading") {
    return <main className="dawn-gradient min-h-screen w-full" />;
  }

  if (mode === "welcome") {
    return <Welcome onComplete={handleWelcomeComplete} />;
  }

  if (mode === "morning-welcome") {
    return <MorningWelcome onComplete={handleMorningWelcomeComplete} />;
  }

  if (mode === "routine") {
    return (
      <motion.main
        className="dawn-gradient min-h-screen w-full flex items-stretch justify-center"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5, ease: "easeOut" }}
      >
        <div className="w-full max-w-[600px] mx-auto relative">
          <RoutineContainer onComplete={handleRoutineComplete} />
        </div>
      </motion.main>
    );
  }

  return (
    <motion.main
      className="dawn-gradient min-h-screen w-full"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.7, ease: "easeOut" }}
    >
      <div className="w-full max-w-[600px] mx-auto">
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            variants={tabFade}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ duration: 0.35, ease: "easeOut" }}
          >
            {activeTab === "today" && (
              <AmbientContainer onStartRoutine={handleStartRoutine} />
            )}
            {activeTab === "routine" && !editingRoutineId && (
              <RoutinesList embedded onOpen={setEditingRoutineId} />
            )}
            {activeTab === "routine" && editingRoutineId && (
              <RoutineBuilder routineId={editingRoutineId} onClose={() => setEditingRoutineId(null)} />
            )}
            {activeTab === "schedule" && <ScheduleView />}
          </motion.div>
        </AnimatePresence>
      </div>

      <TabBar active={activeTab} onChange={setActiveTab} />
    </motion.main>
  );
}
