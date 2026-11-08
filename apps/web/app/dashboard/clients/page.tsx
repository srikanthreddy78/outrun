import { asc, clients, ne } from "@outrun/core/db/query";
import { OUTRUN_CLIENT_ID } from "@outrun/core/constants";
import { clientFocus, proposalsFor } from "@outrun/core/insights";
import {
  acceptProposalAction,
  addClientAction,
  confirmProfileAction,
  pauseAction,
  rejectProposalAction,
  startProfilingAction,
} from "../../../lib/clients-actions";
import { getRuntime } from "../../../lib/runtime";

export const dynamic = "force-dynamic";

const NEXT: Record<string, string> = {
  draft: "Run pnpm clients:export, then naive up (your go), then start profiling.",
  profiling: "Its researcher is drafting the target customer and offer from the client's site.",
  awaiting_confirmation: "Review the draft below, edit it if needed, and confirm.",
  email_setup: "Confirmed. The client's sending domain needs verifying before outreach.",
  active: "Running: the CEO starts its crew each weekday.",
  paused: "Paused: its crew is refused and the CEO skips it.",
};

/** The owner's clients: add one, start its profile, confirm it, pause or resume. */
export default async function ClientsPage() {
  const rt = await getRuntime();
  const rows = await rt.db.db
    .select()
    .from(clients)
    .where(ne(clients.id, OUTRUN_CLIENT_ID))
    .orderBy(asc(clients.createdAt));
  const learned = new Map(
    await Promise.all(
      rows.map(
        async (c) =>
          [
            c.id,
            {
              focus: await clientFocus(rt.db.db, c.id),
              open: (await proposalsFor(rt.db.db, c.id)).filter((p) => p.status === "open"),
            },
          ] as const,
      ),
    ),
  );
  return (
    <>
      <h1>Clients</h1>
      <p>Each client gets its own crew of six agents. Outreach starts only after you confirm its profile.</p>

      <section className="team-card">
        <h2>Add a client</h2>
        <form action={addClientAction} style={{ display: "grid", gap: "0.5rem", maxWidth: "32rem" }}>
          <label>
            Company name
            <input name="name" required maxLength={80} style={{ width: "100%" }} />
          </label>
          <label>
            Website domain (e.g. acme.com)
            <input name="domain" required maxLength={253} style={{ width: "100%" }} />
          </label>
          <label>
            Slug (optional; used in agent names)
            <input name="slug" maxLength={40} pattern="[a-z0-9]+(-[a-z0-9]+)*" style={{ width: "100%" }} />
          </label>
          <label>
            Client approvers (emails, one per line; they approve this client&apos;s emails)
            <textarea name="approvers" rows={2} style={{ width: "100%" }} />
          </label>
          <button type="submit">Add client</button>
        </form>
      </section>

      {rows.length === 0 && <p>No clients yet.</p>}
      {rows.map((c) => (
        <section key={c.id} className="team-card" style={{ marginTop: "1rem" }}>
          <h2>
            {c.name}{" "}
            <small>
              ({c.domain} · {c.slug})
            </small>
          </h2>
          <p>
            <strong>{c.status}</strong>: {NEXT[c.status]}
          </p>
          {c.status === "draft" && (
            <form action={startProfilingAction}>
              <input type="hidden" name="clientId" value={c.id} />
              <button type="submit">Start profiling (its crew must exist on Naive)</button>
            </form>
          )}
          {Object.keys(c.profile).length > 0 && (
            <form action={confirmProfileAction} style={{ display: "grid", gap: "0.5rem" }}>
              <input type="hidden" name="clientId" value={c.id} />
              <label>
                Profile {c.profileConfirmedAt ? `(confirmed by ${c.confirmedBy})` : "(draft, not confirmed)"}
                <textarea
                  name="profile"
                  rows={18}
                  defaultValue={JSON.stringify(c.profile, null, 2)}
                  style={{ width: "100%", fontFamily: "monospace" }}
                />
              </label>
              <button type="submit">{c.profileConfirmedAt ? "Save changes" : "Confirm profile"}</button>
            </form>
          )}
          {learned.get(c.id)?.focus && (
            <p>
              CEO focus: {learned.get(c.id)!.focus!.dailyDraftLimit} first emails a day (
              {learned.get(c.id)!.focus!.reason})
            </p>
          )}
          {learned.get(c.id)?.open.map((p) => (
            <div key={p.proposalId} className="team-card" style={{ margin: "0.5rem 0" }}>
              <p>
                <strong>The CEO proposes a profile change</strong> ({p.at.toISOString().slice(0, 10)})
              </p>
              <pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(p.changes, null, 2)}</pre>
              <p>Evidence: {p.evidence}</p>
              <form action={acceptProposalAction} style={{ display: "inline" }}>
                <input type="hidden" name="clientId" value={c.id} />
                <input type="hidden" name="proposalId" value={p.proposalId} />
                <button type="submit">Accept</button>
              </form>{" "}
              <form action={rejectProposalAction} style={{ display: "inline" }}>
                <input type="hidden" name="clientId" value={c.id} />
                <input type="hidden" name="proposalId" value={p.proposalId} />
                <input name="reason" maxLength={500} placeholder="Why not (optional)" />
                <button type="submit">Reject</button>
              </form>
            </div>
          ))}
          {c.dnsRecords.length > 0 && (
            <>
              <p>
                Sending domain {c.sendingDomain}: <strong>{c.dnsStatus}</strong>. The client adds these
                records at its DNS host; we re-check every 15 minutes.
              </p>
              <table>
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Name</th>
                    <th>Value</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {c.dnsRecords.map((r) => (
                    <tr key={`${r.type}:${r.name}:${r.value}`}>
                      <td>{r.type}</td>
                      <td>{r.name}</td>
                      <td style={{ wordBreak: "break-all" }}>
                        {r.priority !== undefined ? `${r.priority} ` : ""}
                        {r.value}
                      </td>
                      <td>{r.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          <form action={pauseAction} style={{ marginTop: "0.5rem" }}>
            <input type="hidden" name="clientId" value={c.id} />
            <input type="hidden" name="paused" value={c.status === "paused" ? "false" : "true"} />
            <button type="submit">{c.status === "paused" ? "Resume" : "Pause"}</button>
          </form>
        </section>
      ))}
    </>
  );
}
