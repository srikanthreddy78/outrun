"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export function AutoRefresh({ everyMs = 2_000 }: { everyMs?: number } = {}) {
  const router = useRouter();
  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, everyMs);
    return () => window.clearInterval(interval);
  }, [router, everyMs]);
  return null;
}
