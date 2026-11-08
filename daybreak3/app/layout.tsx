import type { Metadata, Viewport } from "next";
import { Fraunces, Inter } from "next/font/google";
import Script from "next/script";
import { PageTransition } from "@/components/ui/PageTransition";
import { Grain } from "@/components/design/Grain";
import "./globals.css";

const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-fraunces",
  axes: ["opsz"],
  style: ["normal", "italic"],
  display: "swap",
});

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  weight: ["300", "400", "500"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Daybreak",
  description: "A guided morning routine to start your day with intention.",
  openGraph: {
    title: "Daybreak",
    description: "A ritual, not a routine. A calm, intentional way to start your morning.",
    type: "website",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  // theme-color is set per time-of-day palette by the inline script below so the
  // Android status-bar band blends into the gradient (iOS overlays it, so it's
  // fine there regardless).
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${fraunces.variable} ${inter.variable} h-full`} suppressHydrationWarning>
      <head>
        {/* Time-of-day sky: set the palette by the hour before first paint (no
            flash). dawn = early morning + evening/night, morning = mid-morning,
            day = midday + afternoon. Also sets the theme-color meta to each
            palette's gradient-top so the Android status-bar band blends in
            (iOS overlays the status bar, so it's unaffected). */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var h=new Date().getHours();var m=(h<6||h>=19)?'dawn':(h<11?'morning':'day');if(m!=='morning')document.documentElement.dataset.sky=m;var c={morning:'#EDC086',dawn:'#E4AC8E',day:'#FDE6BC'}[m];var t=document.querySelector(\"meta[name='theme-color']\");if(!t){t=document.createElement('meta');t.setAttribute('name','theme-color');document.head.appendChild(t);}t.setAttribute('content',c);}catch(e){}})();",
          }}
        />
        <link rel="manifest" href="/manifest.json" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="apple-mobile-web-app-title" content="Daybreak" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <Script id="sw-register" strategy="afterInteractive">{`
          if ('serviceWorker' in navigator) {
            ${process.env.NODE_ENV === "production"
              ? `navigator.serviceWorker.register('/sw.js').catch(() => {});`
              : `navigator.serviceWorker.getRegistrations().then(regs => regs.forEach(r => r.unregister()));`
            }
          }
        `}</Script>
      </head>
      <body className="h-full">
        {/* Single animated gradient layer. As a direct child of <body> it sits
            outside PageTransition's transformed/fixed wrapper, so its
            `fixed inset-0` stays viewport-relative and fills the whole screen
            (incl. safe areas) on every route. Screens are transparent and show
            this through. */}
        <div aria-hidden className="sky fixed inset-0 pointer-events-none" style={{ zIndex: -10 }} />
        {/* Paper-grain over the atmosphere (behind all content) so the warm wash
            reads as morning light, not a flat CSS fill. */}
        <Grain opacity={0.05} blend="soft-light" zIndex={-9} />
        <PageTransition>{children}</PageTransition>
      </body>
    </html>
  );
}
