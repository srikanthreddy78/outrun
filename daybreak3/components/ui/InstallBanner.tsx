"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { storage } from "@/lib/storage";

export function InstallBanner() {
  const router = useRouter();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Don't show if already installed as PWA
    if (window.matchMedia("(display-mode: standalone)").matches) return;
    // Don't show on desktop
    if (!/iPhone|iPad|iPod|Android/i.test(navigator.userAgent)) return;
    // Don't show if already dismissed
    if (storage.getInstallBannerSeen()) return;
    setVisible(true);
  }, []);

  const handleDismiss = () => {
    storage.setInstallBannerSeen();
    setVisible(false);
  };

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ duration: 0.4, ease: "easeOut" }}
          className="flex items-center justify-between gap-3 px-5 py-3 mx-4 mb-2 rounded-2xl"
          style={{ background: "rgba(42,31,24,0.06)", border: "1px solid rgba(42,31,24,0.09)" }}
        >
          <button
            onClick={() => router.push("/install")}
            className="text-xs font-[Inter] font-light text-left flex-1"
            style={{ color: "#4A3728", opacity: 0.7 }}
          >
            Add Daybreak to your home screen for the best experience →
          </button>
          <button
            onClick={handleDismiss}
            className="text-xs font-[Inter] shrink-0"
            style={{ color: "#4A3728", opacity: 0.35 }}
            aria-label="Dismiss"
          >
            ✕
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
