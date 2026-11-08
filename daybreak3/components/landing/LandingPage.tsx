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
              <strong className="font-medium">I&apos;ve believed this for as long as I can remember.</strong> If I don&apos;t start my morning right, I tend to feel unproductive, restless, and scatter-brained throughout the rest of the day. As such, I have always put heavy emphasis on getting my mornings right.
            </p>
            <p className="text-[#2A1F18]/80 text-lg font-[Inter] font-light leading-relaxed">
              <strong className="font-medium">But doing so was way harder than it should&apos;ve been</strong> — my main problems being consistency (completing all the steps in the routine each day) and a lack of structure (without a basis for how long each part should take, it always felt like I was moving through routines instead of actually being in them).
            </p>
            <p className="text-[#2A1F18]/80 text-lg font-[Inter] font-light leading-relaxed">
              Naturally, I turned to the plethora of morning routine apps available on the app store, but none of them really stuck. They were all cluttered, feature-heavy, and packed with metrics and streaks and reminders — which, to me, is <strong className="font-medium">the complete opposite of what a morning should feel like</strong>. And underneath the noise, something more subtle was off: <strong className="font-medium">I never really felt like the morning was mine</strong>. The apps were focused on the act of building a routine — adding habits, checking boxes, hitting goals.
            </p>
            <p className="text-[#2A1F18]/80 text-lg font-[Inter] font-light leading-relaxed">
              But I don&apos;t think of my morning as a routine. I think of it as a ritual. Checking the weather. A quote to sit with. Words of positivity left from days prior. <strong className="font-medium">A breath before the day begins.</strong>
            </p>
            <p className="text-[#2A1F18]/80 text-lg font-[Inter] font-light leading-relaxed">
              That&apos;s what I wanted, and I couldn&apos;t find it. <strong className="font-medium">So I built it.</strong>
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

          {/* Footer */}
          <p className="text-[#4A3728] text-xs font-[Inter] opacity-25 text-center pb-4">
            Built by Matthew Huang.
          </p>
        </motion.div>
      </div>
    </main>
  );
}
