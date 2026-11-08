import type { ReactNode } from "react";

/** The landing page's wordmark, linking home. */
export function Wordmark() {
  return (
    <a className="p-wordmark" href="/" aria-label="Outrun, home">
      <svg viewBox="0 0 28 18" aria-hidden="true" focusable="false">
        <rect x="6" y="1" width="22" height="3" rx="1.5" />
        <rect x="0" y="7.5" width="28" height="3" rx="1.5" />
        <rect x="10" y="14" width="18" height="3" rx="1.5" />
      </svg>
      <span>Outrun</span>
    </a>
  );
}

/** The portal's masthead: the wordmark, and whatever goes on the right (who is signed in). */
export function Masthead({ children }: { children?: ReactNode }) {
  return (
    <header className="p-mast">
      <Wordmark />
      {children && <div className="p-mast__who">{children}</div>}
    </header>
  );
}
