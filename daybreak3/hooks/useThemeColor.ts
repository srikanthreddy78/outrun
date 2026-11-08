import { useEffect } from "react";

// Temporarily override the status-bar theme-color while a screen is mounted
// (e.g. a dark screen over the warm gradient), restoring whatever it
// was before on unmount. The base palette color is set on load in layout.tsx.
export function useThemeColor(color: string) {
  useEffect(() => {
    const meta = document.querySelector("meta[name='theme-color']");
    if (!meta) return;
    const prev = meta.getAttribute("content");
    meta.setAttribute("content", color);
    return () => {
      if (prev !== null) meta.setAttribute("content", prev);
    };
  }, [color]);
}
