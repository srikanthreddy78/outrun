/**
 * The real AgentMail client (SH-1). Plain-text mail from one inbox; replies stay in their thread.
 * AgentMail has no idempotency key, so the send_email job guards with the message's status
 * (sending → sent) and never calls send twice for one message id.
 * https://docs.agentmail.to/api-reference/inboxes/messages/send
 */
import { createHash } from "node:crypto";
import { AppError } from "../errors";
import { getJson, postJson } from "./http";
import type { AgentMailClient, AgentMailDomain } from "./types";

export const AGENTMAIL_API = "https://api.agentmail.to/v0";
const TIMEOUT_MS = 20_000;

type DomainRow = {
  domain_id: string;
  domain: string;
  status: string;
  records?: { type: string; name: string; value: string; status: string; priority?: number }[];
};
const toDomain = (d: DomainRow): AgentMailDomain => ({
  domainId: d.domain_id,
  domain: d.domain,
  status: d.status,
  records: (d.records ?? []).map((r) => ({
    type: r.type,
    name: r.name,
    value: r.value,
    status: r.status,
    ...(r.priority !== undefined ? { priority: r.priority } : {}),
  })),
});

export function createAgentMailClient(apiKey: string, inboxId: string): AgentMailClient {
  const headers = { authorization: `Bearer ${apiKey}` };
  const opts = { headers, timeoutMs: TIMEOUT_MS, provider: "agentmail" };
  const inboxUrl = (id: string) => `${AGENTMAIL_API}/inboxes/${encodeURIComponent(id)}`;
  const post = <T>(path: string, body: unknown, from: string = inboxId) =>
    postJson<T>(`${inboxUrl(from)}${path}`, body, opts);

  return {
    async send(msg) {
      const mailHeaders = {
        "List-Unsubscribe": msg.listUnsubscribe,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      };
      // A reply goes through the reply endpoint so AgentMail sets In-Reply-To and References.
      const from = msg.inboxId ?? inboxId;
      const r = msg.inReplyTo
        ? await post<{ message_id: string; thread_id: string }>(
            `/messages/${encodeURIComponent(msg.inReplyTo)}/reply`,
            { text: msg.text, headers: mailHeaders },
            from,
          )
        : await post<{ message_id: string; thread_id: string }>(
            "/messages/send",
            { to: msg.to, subject: msg.subject, text: msg.text, headers: mailHeaders },
            from,
          );
      if (!r.message_id) throw new AppError("upstream_error", "agentmail returned no message_id");
      return { providerId: r.message_id, threadId: r.thread_id };
    },

    async sendTransactional(msg) {
      const r = await post<{ message_id: string }>("/messages/send", {
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        labels: [
          "transactional",
          `key-${createHash("sha256").update(msg.idempotencyKey).digest("hex").slice(0, 16)}`,
        ],
      });
      if (!r.message_id) throw new AppError("upstream_error", "agentmail returned no message_id");
      return { providerId: r.message_id };
    },

    // https://docs.agentmail.to/api-reference/domains/create — inbound on, so replies reach us.
    async createDomain(domain, clientId) {
      return toDomain(
        await postJson<DomainRow>(
          `${AGENTMAIL_API}/domains`,
          { domain, inbound_enabled: true, feedback_enabled: true, client_id: clientId },
          opts,
        ),
      );
    },
    async getDomain(domainId) {
      return toDomain(
        await getJson<DomainRow>(`${AGENTMAIL_API}/domains/${encodeURIComponent(domainId)}`, opts),
      );
    },
    async verifyDomain(domainId) {
      await postJson(`${AGENTMAIL_API}/domains/${encodeURIComponent(domainId)}/verify`, {}, opts);
    },
    // https://docs.agentmail.to/api-reference/inboxes/create
    async createInbox(req) {
      const r = await postJson<{ inbox_id: string }>(
        `${AGENTMAIL_API}/inboxes`,
        {
          username: req.username,
          domain: req.domain,
          display_name: req.displayName,
          client_id: req.clientId,
        },
        opts,
      );
      if (!r.inbox_id) throw new AppError("upstream_error", "agentmail returned no inbox_id");
      return { inboxId: r.inbox_id };
    },
  };
}
