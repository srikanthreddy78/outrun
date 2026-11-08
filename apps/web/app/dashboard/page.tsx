import { autonomyReport } from "@outrun/core/autonomy";
import { getRuntime } from "../../lib/runtime";
import { Feed } from "../ops/Feed";
import "../ops/ops.css";

export const dynamic = "force-dynamic";

const sections = [
  { title: "Agency", href: "/dashboard/agency", detail: "The CEO's brief, every client and its crew." },
  { title: "Clients", href: "/dashboard/clients", detail: "Add, profile, confirm and pause clients." },
  { title: "Approvals", href: "/dashboard/approvals", detail: "Review work waiting for a person." },
  { title: "Ledger", href: "/dashboard/ledger", detail: "Every event, the pipeline and its costs." },
] as const;

/** Overview: the unredacted autonomy report for the last 7 days, then the main sections. */
export default async function DashboardHome() {
  const rt = await getRuntime();
  const now = new Date();
  const r = await autonomyReport(rt.db.db, {
    since: new Date(now.getTime() - 7 * 24 * 3_600_000),
    until: now,
  });
  const stats: [string, string][] = [
    ["Ran without a person", r.autonomyPct === null ? "—" : `${r.autonomyPct.toFixed(1)}%`],
    ["Actions counted", String(r.counts.total)],
    ["Human step-ins", String(r.counts.human)],
    ["Agent decisions", String(r.decisions.length === 50 ? "50+" : r.decisions.length)],
    ["Spend", `$${r.spend.totalUsd.toFixed(2)}`],
  ];
  return (
    <>
      <h1>Team workspace</h1>
      <p>
        The last 7 days, from the event ledger. The public, redacted version is at <a href="/ops">/ops</a>.
      </p>
      <div className="team-cards">
        {stats.map(([label, value]) => (
          <div className="team-card" key={label}>
            <p>{label}</p>
            <h2 style={{ fontSize: "2rem", margin: "6px 0 0" }}>{value}</h2>
          </div>
        ))}
      </div>
      <div className="team-cards">
        <section className="team-card">
          <h2>Where a human stepped in</h2>
          <Feed items={r.stepIns.slice(0, 8)} empty="Nobody stepped in this week." />
        </section>
        <section className="team-card">
          <h2>Latest agent decisions</h2>
          <Feed items={r.decisions.slice(0, 8)} empty="No decisions yet this week." />
        </section>
      </div>
      <div className="team-cards">
        {sections.map((section) => (
          <a className="team-card" key={section.href} href={section.href}>
            <h2>{section.title}</h2>
            <p>{section.detail}</p>
          </a>
        ))}
      </div>
    </>
  );
}
