"use client";

/**
 * Subtle film-grain / paper-noise overlay. Pure inline SVG (feTurbulence) so
 * there's no asset to ship. Sits above the gradient, below content, and gives
 * the flat CSS wash a tactile "morning light" quality. Tune with `opacity` and
 * `blend` per surface — paper wants "soft-light", glow wants "overlay". Pass a
 * negative `zIndex` to park it behind app content (app-wide use in layout).
 */
export function Grain({
  opacity = 0.055,
  blend = "soft-light",
  baseFrequency = 0.9,
  zIndex = 0,
}: {
  opacity?: number;
  blend?: React.CSSProperties["mixBlendMode"];
  baseFrequency?: number;
  zIndex?: number;
}) {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='140' height='140'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='${baseFrequency}' numOctaves='2' stitchTiles='stitch'/><feColorMatrix type='saturate' values='0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>`;
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0"
      style={{
        zIndex,
        opacity,
        mixBlendMode: blend,
        backgroundImage: `url("data:image/svg+xml;utf8,${svg}")`,
        backgroundSize: "140px 140px",
      }}
    />
  );
}
