"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";

type Platform = "iphone" | "android";

const steps: Record<Platform, { num: string; text: string }[]> = {
  iphone: [
    { num: "1", text: "Open Daybreak in Safari. It won't work from Chrome or other browsers." },
    { num: "2", text: "Tap the Share button at the bottom of the screen — the square with an arrow pointing up." },
    { num: "3", text: "Scroll down and tap Add to Home Screen, then tap Add." },
  ],
  android: [
    { num: "1", text: "Open Daybreak in Chrome. Other browsers may not support installation." },
    { num: "2", text: "Tap the three-dot menu in the top-right corner of the browser." },
    { num: "3", text: "Tap Add to Home Screen, then tap Add when prompted." },
  ],
};

export default function InstallPage() {
  const [tab, setTab] = useState<Platform>("iphone");

  useEffect(() => {
    const ua = navigator.userAgent;
    if (/android/i.test(ua)) {
      setTab("android");
    }
  }, []);

  return (
    <main className="dawn-gradient min-h-screen w-full flex items-stretch justify-center">
      <div className="w-full max-w-[600px] mx-auto px-8 py-16">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: "easeOut" }}
          className="flex flex-col gap-12"
        >
          {/* Heading */}
          <div className="flex flex-col gap-2">
            <h1
              className="text-4xl text-[#2A1F18]"
              style={{ fontFamily: "var(--font-fraunces), Georgia, serif", fontWeight: 300 }}
            >
              Add to home screen.
            </h1>
            <p className="text-[#4A3728] font-[Inter] font-light text-base leading-relaxed">
              Daybreak works best as an installed app — no browser chrome, just the morning.
            </p>
          </div>

          {/* Why Daybreak */}
          <div className="flex flex-col gap-4 border-l-2 border-[#C4936A]/30 pl-5">
            <p className="text-[#2A1F18]/80 font-[Inter] font-light text-base leading-relaxed">
              Most routine apps turn your morning into a to-do list — checkboxes, streaks, little bursts of confetti. Daybreak cuts the clutter. It&apos;s built around the idea that a morning ritual should feel like one.
            </p>
            <p className="text-[#2A1F18]/80 font-[Inter] font-light text-base leading-relaxed">
              It gathers all the small things that make a morning feel grounded — today&apos;s weather, a quote worth sitting with, a moment to breathe or stretch — and lets you decide what belongs. Then it steps back. No notifications, no metrics, no gamification. Just a quiet way to start.
            </p>
          </div>

          {/* Tabs */}
          <div className="flex gap-6 border-b border-[#2A1F18]/10">
            {(["iphone", "android"] as Platform[]).map((p) => (
              <button
                key={p}
                onClick={() => setTab(p)}
                className={[
                  "pb-3 text-sm font-[Inter] font-medium tracking-wide transition-colors cursor-pointer",
                  tab === p
                    ? "text-[#2A1F18] border-b-2 border-[#C4936A]/60 -mb-px"
                    : "text-[#4A3728] opacity-40 hover:opacity-70",
                ].join(" ")}
              >
                {p === "iphone" ? "iPhone" : "Android"}
              </button>
            ))}
          </div>

          {/* Steps */}
          <div className="flex flex-col gap-8">
            {steps[tab].map(({ num, text }) => (
              <div key={num} className="flex gap-5 items-start">
                <span
                  className="text-3xl text-[#C4936A]/60 leading-none shrink-0 w-6 text-right"
                  style={{ fontFamily: "var(--font-fraunces), Georgia, serif", fontWeight: 300 }}
                >
                  {num}
                </span>
                <p className="text-[#2A1F18]/80 font-[Inter] font-light text-base leading-relaxed pt-1">
                  {text}
                </p>
              </div>
            ))}

            <p className="text-[#4A3728] font-[Inter] font-light text-sm opacity-50 pl-11">
              Daybreak will appear on your home screen like any other app.
            </p>
          </div>

          {/* Footer CTA */}
          <div className="flex flex-col gap-2 pt-4">
            <p className="text-[#4A3728] font-[Inter] font-light text-sm opacity-50">
              Already installed?
            </p>
            <Link
              href="/"
              className="text-[#2A1F18] font-[Inter] font-light text-base opacity-70 hover:opacity-100 transition-opacity self-start"
            >
              Open Daybreak →
            </Link>
          </div>
        </motion.div>
      </div>
    </main>
  );
}
