"use client";

import { useEffect, useState } from "react";
import { storage } from "@/lib/storage";
import { getGreeting, formatDate, formatTime } from "@/lib/time";
import { Button } from "@/components/ui/Button";
import { fraunces } from "@/components/ui/kit";

interface GreetingProps {
  onNext: () => void;
  onSkip: () => void;
}



export function Greeting({ onNext, onSkip }: GreetingProps) {
  const [greeting, setGreeting] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  useEffect(() => {
    const { userName } = storage.getSettings();
    const now = new Date();
    setGreeting(getGreeting(userName || ""));
    setDate(formatDate(now));
    setTime(formatTime(now));
  }, []);

  // Split "Good morning, Matthew." → ["Good morning,", "Matthew."]
  const commaIndex = greeting.indexOf(", ");
  const line1 = commaIndex !== -1 ? greeting.slice(0, commaIndex + 1) : greeting;
  const line2 = commaIndex !== -1 ? greeting.slice(commaIndex + 2) : "";

  return (
    <div className="flex flex-col items-center justify-start min-h-full pt-[28vh] px-8 text-center gap-12">
      <div className="flex flex-col items-center gap-6">
        <div className="flex flex-col items-center gap-1.5">
          {line2 && (
            <p className="text-[19px] text-[#4A3728]" style={fraunces(300, true)}>
              {line1}
            </p>
          )}
          <h1
            className="text-6xl leading-[1.0] text-[#2A1F18]"
            style={fraunces(300)}
          >
            {line2 || line1}
          </h1>
        </div>
        <div className="flex flex-col items-center gap-1.5">
          <p className="text-[11px] font-[Inter] font-medium uppercase tracking-[0.24em] text-[#4A3728]/70">
            {date}
          </p>
          <p className="text-[#4A3728] text-sm font-[Inter] font-light opacity-55">{time}</p>
        </div>
      </div>

      <div className="flex flex-col items-center gap-4">
        <Button onClick={onNext}>Begin</Button>
        <Button variant="ghost" onClick={onSkip}>skip</Button>
      </div>
    </div>
  );
}
