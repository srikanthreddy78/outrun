import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { auth, signOut } from "../../auth";
import { dashboardAccess } from "../../lib/team-access";
import { AutoRefresh } from "./_components/AutoRefresh";
import "./dashboard.css";

export const dynamic = "force-dynamic";

const links = [
  ["Overview", "/dashboard"],
  ["Approvals", "/dashboard/approvals"],
  ["Ledger", "/dashboard/ledger"],
  ["Orders", "/dashboard/orders"],
  ["Agents", "/dashboard/agents"],
  ["Health", "/dashboard/health"],
] as const;

async function logout() {
  "use server";
  await signOut({ redirectTo: "/" });
}

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/api/auth/signin?callbackUrl=%2Fdashboard");
  if (!dashboardAccess(session.user.email, process.env.AUTH_GITHUB_ALLOWLIST ?? ""))
    redirect("/access-denied");

  return (
    <div className="team-dashboard">
      <aside className="team-sidebar">
        <a className="team-brand" href="/dashboard">
          Outrun <span>Team</span>
        </a>
        <nav aria-label="Team dashboard">
          {links.map(([label, href]) => (
            <a key={href} href={href}>
              {label}
            </a>
          ))}
        </nav>
        <div className="team-account">
          <span>{session.user.email}</span>
          <form action={logout}>
            <button type="submit">Sign out</button>
          </form>
        </div>
      </aside>
      <main className="team-content">
        <AutoRefresh />
        {children}
      </main>
    </div>
  );
}
