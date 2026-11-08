"use client";

import { useRouter } from "next/navigation";
import { motion, useReducedMotion } from "framer-motion";

export function LandingPage() {
  const router = useRouter();
  const shouldReduce = useReducedMotion() ?? false;

  return (
    <main className="dawn-gradient min-h-screen w-full relative overflow-x-hidden flex items-stretch justify-center">
      {/* Breathing ambient light */}
      <motion.div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse 90% 55% at 50% 12%, rgba(255, 208, 120, 0.24) 0%, transparent 68%)",
        }}
        animate={shouldReduce ? undefined : { opacity: [0.45, 1, 0.45] }}
        transition={{ duration: 8, repeat: Infinity, ease: "easeInOut" }}
      />

      <div className="w-full max-w-[600px] mx-auto px-6 relative">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, ease: "easeOut" }}
          className="flex flex-col gap-10 py-20"
        >
          {/* Hero */}
          <div className="flex flex-col gap-5 pt-8">
            <h1
              className="text-6xl text-[#2A1F18]"
              style={{ fontFamily: "var(--font-fraunces), Georgia, serif", fontWeight: 300 }}
            >
              Daybreak.
            </h1>
            <p
              className="text-2xl text-[#4A3728]/70 leading-snug"
              style={{ fontFamily: "var(--font-fraunces), Georgia, serif", fontWeight: 300, fontStyle: "italic" }}
            >
              The morning sets the tone.
            </p>
          </div>

          {/* Story */}
          <div className="flex flex-col gap-7">
            <p className="text-[#2A1F18]/80 text-lg font-[Inter] font-light leading-relaxed">
              <strong className="font-medium">The first few minutes of a day matter.</strong> A thoughtful start can make the rest of the day feel calmer, clearer, and more intentional.
            </p>
            <p className="text-[#2A1F18]/80 text-lg font-[Inter] font-light leading-relaxed">
              <strong className="font-medium">That should not require another noisy dashboard.</strong> A morning ritual needs just enough structure to feel supportive, without turning into another task list.
            </p>
            <p className="text-[#2A1F18]/80 text-lg font-[Inter] font-light leading-relaxed">
              Many routine tools are crowded with metrics, streaks, and reminders. Daybreak keeps the focus on a small set of moments you choose for yourself.
            </p>
            <p className="text-[#2A1F18]/80 text-lg font-[Inter] font-light leading-relaxed">
              Check the weather, sit with a quote, write a note, or take a breath before the day begins. <strong className="font-medium">Your ritual can be as simple as it needs to be.</strong>
            </p>
            <p className="text-[#2A1F18]/80 text-lg font-[Inter] font-light leading-relaxed">
              Daybreak is a local-first template for building that kind of morning.
            </p>
          </div>

          {/* Section divider */}
          <div className="border-t border-[#2A1F18]/[0.08] my-2" />

          {/* Product */}
          <div className="flex flex-col gap-7">
            <h2
              className="text-3xl text-[#2A1F18] leading-snug"
              style={{ fontFamily: "var(--font-fraunces), Georgia, serif", fontWeight: 300 }}
            >
              Daybreak is a doorway, not a dashboard.
            </h2>
            <p className="text-[#2A1F18]/80 text-lg font-[Inter] font-light leading-relaxed">
              Most morning apps are control panels — stacks of widgets, metrics, streaks, and reminders that demand your attention before you&apos;ve even had water. Daybreak is the opposite. It&apos;s the small, quiet thing you pass through on the way into your day.
            </p>
            <p
              className="text-xl text-[#2A1F18]/85"
              style={{ fontFamily: "var(--font-fraunces), Georgia, serif", fontWeight: 300, fontStyle: "italic" }}
            >
              You design your morning. Daybreak walks you through it.
            </p>
            <p className="text-[#2A1F18]/80 text-lg font-[Inter] font-light leading-relaxed">
              The whole point is to be less — less to manage, less to look at, less standing between you and the morning you actually want.
            </p>
            <p
              className="text-lg text-[#2A1F18]/55"
              style={{ fontFamily: "var(--font-fraunces), Georgia, serif", fontWeight: 300, fontStyle: "italic" }}
            >
              A ritual, not a routine. A doorway, not a dashboard.
            </p>
          </div>

          {/* CTA */}
          <div className="flex flex-col items-center gap-3 pt-2">
            <motion.button
              onClick={() => router.push("/")}
              whileTap={{ scale: 0.97 }}
              whileHover={{ opacity: 0.8 }}
              className="px-10 py-4 rounded-full border border-[#2A1F18]/20 text-[#2A1F18] text-xl bg-[#2A1F18]/[0.06] hover:bg-[#2A1F18]/10 transition-colors cursor-pointer"
              style={{ fontFamily: "var(--font-fraunces), Georgia, serif", fontWeight: 300 }}
            >
              Start your morning →
            </motion.button>
            <p className="text-[#4A3728] text-sm font-[Inter] font-light opacity-40">
              free · your data stays on this device
            </p>
          </div>

        </motion.div>
      </div>
    </main>
  );
}
