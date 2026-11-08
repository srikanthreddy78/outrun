"use client";

/**
 * Shared "hybrid" design atoms — the vocabulary every screen is built from:
 * an editorial type grid (tiny tracked labels + serif values), hairline rules
 * for structure, and Open's cream circular affordance. Lit app-wide by the aura
 * atmosphere (globals.css) + paper grain (layout). Keep visual choices here so
 * the whole app stays consistent from one place.
 */

// Fraunces is always set via inline style (opsz axis + weight/italic control).
export const fraunces = (weight = 300, italic = false) =>
  ({
    fontFamily: "var(--font-fraunces), Georgia, serif",
    fontWeight: weight,
    fontStyle: italic ? ("italic" as const) : ("normal" as const),
  }) as const;

// Tiny, tracked-out, uppercase — the "almanac" label. Deliberately small and
// muted so the serif value below carries the weight.
export function Label({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p
      className={`text-[11px] font-[Inter] font-medium uppercase tracking-[0.24em] text-[#4A3728]/80 ${className}`}
    >
      {children}
    </p>
  );
}

// The one structural device — a warm hairline. Depth from line, not from boxes.
export function Rule({ className = "" }: { className?: string }) {
  return <div className={`h-px w-full bg-[#2A1F18]/10 ${className}`} />;
}

// Cream circular button — Open's recurring affordance, translated to the warm
// theme. Pass an icon as children (defaults to a forward arrow).
export function CircleButton({
  onClick,
  ariaLabel,
  size = 52,
  disabled = false,
  children,
  className = "",
}: {
  onClick?: () => void;
  ariaLabel: string;
  size?: number;
  disabled?: boolean;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className={`flex shrink-0 items-center justify-center rounded-full transition-transform active:scale-95 disabled:opacity-40 ${className}`}
      style={{
        width: size,
        height: size,
        background: "linear-gradient(160deg, #FBF3E4 0%, #F1E4CE 100%)",
        boxShadow:
          "0 1px 0 0 rgba(255,255,255,0.7) inset, 0 14px 30px -16px rgba(90,55,30,0.5)",
      }}
    >
      {children ?? <ArrowRightIcon />}
    </button>
  );
}

export function ArrowRightIcon({ size = 19 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path
        d="M5 12h13M12 5l7 7-7 7"
        stroke="#2A1F18"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
