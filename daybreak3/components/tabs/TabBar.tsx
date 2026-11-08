"use client";

import { motion } from "framer-motion";
import { playNavigate } from "@/lib/audio";
import { hapticLight } from "@/lib/haptics";

export type Tab = "today" | "routine" | "schedule";

interface TabBarProps {
  active: Tab;
  onChange: (tab: Tab) => void;
}

function IconSun() {
  return (
    <svg width="19" height="19" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <circle cx="9" cy="9" r="3" />
      <line x1="9" y1="1" x2="9" y2="3" />
      <line x1="9" y1="15" x2="9" y2="17" />
      <line x1="1" y1="9" x2="3" y2="9" />
      <line x1="15" y1="9" x2="17" y2="9" />
      <line x1="3.5" y1="3.5" x2="4.9" y2="4.9" />
      <line x1="13.1" y1="13.1" x2="14.5" y2="14.5" />
      <line x1="3.5" y1="14.5" x2="4.9" y2="13.1" />
      <line x1="13.1" y1="4.9" x2="14.5" y2="3.5" />
    </svg>
  );
}

function IconList() {
  return (
    <svg width="19" height="19" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <line x1="4" y1="6" x2="14" y2="6" />
      <line x1="4" y1="9" x2="14" y2="9" />
      <line x1="4" y1="12" x2="10" y2="12" />
    </svg>
  );
}

function IconCalendar() {
  return (
    <svg width="19" height="19" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.5" y="3.5" width="13" height="12" rx="2" />
      <line x1="2.5" y1="7" x2="15.5" y2="7" />
      <line x1="6" y1="1.5" x2="6" y2="5" />
      <line x1="12" y1="1.5" x2="12" y2="5" />
      <line x1="6" y1="10.5" x2="6" y2="10.5" strokeWidth="2" />
      <line x1="9" y1="10.5" x2="9" y2="10.5" strokeWidth="2" />
      <line x1="12" y1="10.5" x2="12" y2="10.5" strokeWidth="2" />
      <line x1="6" y1="13.5" x2="6" y2="13.5" strokeWidth="2" />
      <line x1="9" y1="13.5" x2="9" y2="13.5" strokeWidth="2" />
    </svg>
  );
}

const TABS: { id: Tab; label: string; Icon: React.FC }[] = [
  { id: "today",    label: "Today",    Icon: IconSun },
  { id: "routine",  label: "Routine",  Icon: IconList },
  { id: "schedule", label: "Schedule", Icon: IconCalendar },
];

export function TabBar({ active, onChange }: TabBarProps) {
  return (
    <div
      className="fixed bottom-0 left-0 right-0 z-50 select-none"
      style={{
        borderTop: "1px solid rgba(42,31,24,0.06)",
        background:
          "linear-gradient(to top, rgba(250,242,232,0.44) 0%, rgba(250,242,232,0.08) 100%)",
        backdropFilter: "blur(24px) saturate(1.3)",
        WebkitBackdropFilter: "blur(24px) saturate(1.3)",
      }}
    >
      <div className="flex max-w-[600px] mx-auto">
        {TABS.map(({ id, label, Icon }) => {
          const isActive = active === id;
          return (
            <button
              key={id}
              onClick={() => { if (id !== active) { playNavigate(); hapticLight(); } onChange(id); }}
              className="group flex-1 flex flex-col items-center justify-center gap-0.5 pt-3 pb-2 cursor-pointer"
            >
              <span
                className={`transition-opacity duration-200 ${isActive ? "opacity-[0.85]" : "opacity-[0.28] group-active:opacity-[0.5]"}`}
                style={{ color: "#2A1F18" }}
              >
                <Icon />
              </span>
              <span
                className={`text-[10px] font-[Inter] tracking-wide transition-opacity duration-200 ${isActive ? "opacity-[0.65]" : "opacity-[0.28] group-active:opacity-[0.5]"}`}
                style={{ color: "#4A3728" }}
              >
                {label}
              </span>
              <div className="h-1.5 flex items-center justify-center">
                {isActive && (
                  <motion.div
                    layoutId="tab-dot"
                    className="w-1 h-1 rounded-full"
                    style={{ backgroundColor: "#B08060", opacity: 0.55 }}
                    transition={{ type: "spring", stiffness: 500, damping: 35 }}
                  />
                )}
              </div>
            </button>
          );
        })}
      </div>
      <div style={{ height: "env(safe-area-inset-bottom, 0px)" }} />
    </div>
  );
}
