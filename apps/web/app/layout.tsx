import type { ReactNode } from "react";

export const metadata = {
  title: "Outrun",
  description: "An autonomous growth crew for agent-native businesses.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
