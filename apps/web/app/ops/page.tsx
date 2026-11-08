import { autonomyReport } from "@outrun/core/autonomy";
import { agencyOverview } from "@outrun/core/crew/tools/agency";
import { getRuntime } from "../../lib/runtime";
import { AutoRefresh } from "../dashboard/_components/AutoRefresh";
import { Feed, when } from "./Feed";
import "./ops.css";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Outrun, live",
  description:
    "How much of Outrun runs without a person: what agents delivered, decided, and where a human stepped in.",
};

const WEEK = 7 * 24 * 3_600_000;
const money = (n: number) => `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`;

/** One shared read every few seconds, however many viewers or refresh loops hit the page. */
const CACHE_MS = 10_000;
let cached: { at: number; value: Promise<OpsData> } | null = null;
type OpsData = {
  now: Date;
  r: Awaited<ReturnType<typeof autonomyReport>>;
  overview: Awaited<ReturnType<typeof agencyOverview>>;
};
async function load(): Promise<OpsData> {
  const rt = await getRuntime();
  const now = new Date();
  const [r, overview] = await Promise.all([
    autonomyReport(rt.db.db, { since: new Date(now.getTime() - WEEK), until: now, redact: true }),
    agencyOverview(rt.db.db, now),
  ]);
  // Publicly, only clients the owner confirmed: a fresh signup's name and domain are its own text.
  return { now, r, overview: { ...overview, clients: overview.clients.filter((c) => c.profileConfirmed) } };
}
function opsData(): Promise<OpsData> {
  const t = Date.now();
  if (!cached || t - cached.at > CACHE_MS) {
    const value = load();
    cached = { at: t, value };
    value.catch(() => {
      if (cached?.value === value) cached = null;
    });
  }
  return cached.value;
}

/** Public scoreboard, no login: the redacted autonomy report for the last 7 days. */
export default async function OpsPage() {
  const { now, r, overview } = await opsData();
  const { counts, deliveries: d, spend } = r;
  const pct = (n: number) => (counts.total ? (n / counts.total) * 100 : 0);
  const tiles: [string, number][] = [
    ["Emails sent", d.emailsSent],
    ["Replies handled", d.repliesHandled],
    ["Prospects filed", d.prospectsFiled],
    ["Prospects researched", d.prospectsResearched],
    ["Audits written", d.auditsSaved],
    ["Reports delivered", d.reportsDelivered],
    ["Clients onboarded", d.clientsOnboarded],
    ["Clients gone live", d.clientsActivated],
    ["Orders", d.ordersCreated],
    ["Paid orders", d.ordersPaid],
  ];

  return (
    <main className="ops">
      <AutoRefresh everyMs={10_000} />
      <header className="ops-top">
        <a className="ops-brand" href="/">
          Outrun <span>live</span>
        </a>
        <span className="ops-live">
          <i aria-hidden /> Last 7 days · updated {when(now.toISOString())}
        </span>
      </header>

      <section className="ops-hero">
        <div>
          <p className="ops-kicker">Ran without a person</p>
          <p className="ops-pct">
            {r.autonomyPct === null ? "—" : r.autonomyPct.toFixed(1)}
            <small>%</small>
          </p>
          <p className="ops-sub">
            of {counts.total} business actions this week were taken by agents or the system. People stepped in{" "}
            {counts.human} time{counts.human === 1 ? "" : "s"}.
          </p>
        </div>
        <div className="ops-split">
          <div className="ops-bar" role="img" aria-label="Actions by who took them">
            <span className="ops-seg-agent" style={{ width: `${pct(counts.agent)}%` }} />
            <span className="ops-seg-system" style={{ width: `${pct(counts.system)}%` }} />
            <span className="ops-seg-human" style={{ width: `${pct(counts.human)}%` }} />
          </div>
          <dl className="ops-legend">
            <div>
              <dt className="ops-dot-agent">Agents</dt>
              <dd>{counts.agent}</dd>
            </div>
            <div>
              <dt className="ops-dot-system">System</dt>
              <dd>{counts.system}</dd>
            </div>
            <div>
              <dt className="ops-dot-human">Humans</dt>
              <dd>{counts.human}</dd>
            </div>
          </dl>
          <dl className="ops-spend">
            <div>
              <dt>Spend</dt>
              <dd>{money(spend.totalUsd)}</dd>
            </div>
            <div>
              <dt>Agents</dt>
              <dd>{money(spend.agentUsd)}</dd>
            </div>
            <div>
              <dt>System</dt>
              <dd>{money(spend.systemUsd + spend.humanUsd)}</dd>
            </div>
          </dl>
        </div>
      </section>

      <section>
        <h2>What got delivered</h2>
        <div className="ops-tiles">
          {tiles.map(([label, n]) => (
            <div className="ops-tile" key={label}>
              <strong>{n}</strong>
              <span>{label}</span>
            </div>
          ))}
        </div>
      </section>

      <div className="ops-columns">
        <section className="ops-panel">
          <h2>Decisions agents made</h2>
          <Feed items={r.decisions} empty="No decisions yet this week." />
        </section>
        <section className="ops-panel">
          <h2>Where a human stepped in</h2>
          <Feed items={r.stepIns} empty="Nobody had to step in this week." />
        </section>
      </div>

      <section>
        <h2>Clients and their crews</h2>
        <div className="ops-table-wrap">
          <table className="ops-table">
            <thead>
              <tr>
                <th>Client</th>
                <th>Status</th>
                <th>Sent</th>
                <th>Replies</th>
                <th>Won</th>
                <th>Waiting on a person</th>
                <th>Agent sessions</th>
                <th>Agent spend</th>
              </tr>
            </thead>
            <tbody>
              {overview.clients.map((c) => (
                <tr key={c.clientId}>
                  <td>
                    <strong>{c.name}</strong>
                    <small>{c.domain}</small>
                  </td>
                  <td>
                    <span className={`ops-status ops-status-${c.status}`}>{c.status.replace("_", " ")}</span>
                  </td>
                  <td>{c.sent}</td>
                  <td>{c.replies}</td>
                  <td>{c.won}</td>
                  <td>{c.approvalsWaiting}</td>
                  <td>{c.crew.reduce((s, m) => s + m.sessions, 0)}</td>
                  <td>{money(c.crew.reduce((s, m) => s + m.spendUsd, 0))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <footer className="ops-foot">
        Read straight from Outrun&apos;s event ledger. Emails, message text and uncontacted prospects are left
        out; people appear by role. <a href="/">outrun</a>
      </footer>
    </main>
  );
}
