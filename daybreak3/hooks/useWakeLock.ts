"use client";

import { useEffect } from "react";

// Keeps the screen awake while `active` is true, using the browser Screen Wake
// Lock API, available in Safari / iOS webviews on
// 16.4+, and a harmless no-op on older versions or unsupported platforms.
//
// The OS auto-releases the lock whenever the page is hidden (screen lock, app
// backgrounded), so we re-acquire it on every visibilitychange while the timer
// is still running.
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    if (typeof navigator === "undefined" || !("wakeLock" in navigator)) return;

    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;

    const acquire = async () => {
      try {
        sentinel = await navigator.wakeLock.request("screen");
      } catch {
        // Rejects if the page isn't visible or the OS declines — we'll retry
        // on the next visibilitychange.
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible" && !cancelled) acquire();
    };

    acquire();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      sentinel?.release().catch(() => {});
    };
  }, [active]);
}
