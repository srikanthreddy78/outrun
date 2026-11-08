import type { ReactNode } from "react";
import "./portal.css";

const FONTS =
  "https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@700;800;900&family=Martian+Mono:wdth,wght@75..112.5,400..600&family=Schibsted+Grotesk:ital,wght@0,400;0,500;0,700;1,400&display=swap";

/** The client portal wears the landing page's type and colors. */
export default function PortalLayout({ children }: { children: ReactNode }) {
  return (
    <div className="portal">
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
      <link rel="stylesheet" href={FONTS} precedence="default" />
      {children}
    </div>
  );
}
