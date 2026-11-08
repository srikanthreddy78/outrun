"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export function AutoRefresh() {
  const router = useRouter();
  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, 2_000);
    return () => window.clearInterval(interval);
  }, [router]);
  return null;
}
