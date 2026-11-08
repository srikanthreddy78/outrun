/**
 * SH-4: HubSpot, a one-way mirror of Postgres. Every record is upserted on our id in the
 * `outrun_id` unique custom property (pnpm hubspot:setup creates it), so a rerun never makes a
 * duplicate. A 429 is retryable (http.ts). Our stage is kept in `outrun_stage`; dealstage is
 * the nearest stage of HubSpot's default pipeline.
 */
import { AppError } from "../errors";
import { postJson } from "./http";
import type { HubSpotClient } from "./types";

const BASE = "https://api.hubapi.com";

export const DEAL_STAGE: Record<string, string> = {
  filed: "appointmentscheduled",
  researched: "appointmentscheduled",
  drafted: "appointmentscheduled",
  contacted: "qualifiedtobuy",
  replied: "presentationscheduled",
  interested: "decisionmakerboughtin",
  not_now: "presentationscheduled",
  checkout_sent: "contractsent",
  won: "closedwon",
  lost: "closedlost",
  unsubscribed: "closedlost",
};

export function createHubSpotClient(token: string): HubSpotClient {
  const opts = { headers: { authorization: `Bearer ${token}` }, timeoutMs: 20_000, provider: "hubspot" };
  async function upsert(
    object: string,
    outrunId: string,
    properties: Record<string, string>,
  ): Promise<{ id: string }> {
    const res = await postJson<{ results?: { id: string }[] }>(
      `${BASE}/crm/v3/objects/${object}/batch/upsert`,
      {
        inputs: [
          { idProperty: "outrun_id", id: outrunId, properties: { ...properties, outrun_id: outrunId } },
        ],
      },
      opts,
    );
    const id = res.results?.[0]?.id;
    if (!id)
      throw new AppError("upstream_error", `hubspot: upsert ${object} returned no id`, { retryable: true });
    return { id };
  }
  // Default associations are idempotent: repeating one changes nothing.
  const associate = (from: string, fromId: string, to: string, toId: string) =>
    postJson(`${BASE}/crm/v4/objects/${from}/${fromId}/associations/default/${to}/${toId}`, undefined, {
      ...opts,
      method: "PUT",
    });

  return {
    upsertCompany: (c) => upsert("companies", c.outrunId, { domain: c.domain, name: c.name }),
    async upsertContact(c) {
      const [first, ...rest] = c.name.trim().split(/\s+/);
      const r = await upsert("contacts", c.outrunId, {
        email: c.email,
        firstname: first ?? "",
        lastname: rest.join(" "),
      });
      await associate("contacts", r.id, "companies", c.companyId);
      return r;
    },
    async upsertDeal(d) {
      const r = await upsert("deals", d.outrunId, {
        dealname: d.name,
        pipeline: "default",
        dealstage: DEAL_STAGE[d.stage] ?? "appointmentscheduled",
        outrun_stage: d.stage,
      });
      await associate("deals", r.id, "companies", d.companyId);
      return r;
    },
    async logEmail(e) {
      const res = await postJson<{ id: string }>(
        `${BASE}/crm/v3/objects/emails`,
        {
          properties: {
            hs_timestamp: e.at,
            hs_email_direction: e.direction === "outbound" ? "EMAIL" : "INCOMING_EMAIL",
            hs_email_status: "SENT",
            hs_email_subject: e.subject.slice(0, 500),
            hs_email_text: e.body.slice(0, 60_000),
          },
        },
        opts,
      );
      await associate("emails", res.id, "deals", e.dealId);
    },
  };
}
