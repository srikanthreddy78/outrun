/**
 * The real AgentMail client (SH-1). Plain-text mail from one inbox; replies stay in their thread.
 * AgentMail has no idempotency key, so the send_email job guards with the message's status
 * (sending → sent) and never calls send twice for one message id.
 * https://docs.agentmail.to/api-reference/inboxes/messages/send
 */
import { createHash } from "node:crypto";
import { AppError } from "../errors";
import { postJson } from "./http";
import type { AgentMailClient } from "./types";

export const AGENTMAIL_API = "https://api.agentmail.to/v0";
const TIMEOUT_MS = 20_000;

export function createAgentMailClient(apiKey: string, inboxId: string): AgentMailClient {
  const headers = { authorization: `Bearer ${apiKey}` };
  const inbox = `${AGENTMAIL_API}/inboxes/${encodeURIComponent(inboxId)}`;
  const post = <T>(path: string, body: unknown) =>
    postJson<T>(`${inbox}${path}`, body, { headers, timeoutMs: TIMEOUT_MS, provider: "agentmail" });

  return {
    async send(msg) {
      const mailHeaders = {
        "List-Unsubscribe": msg.listUnsubscribe,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      };
      // A reply goes through the reply endpoint so AgentMail sets In-Reply-To and References.
      const r = msg.inReplyTo
        ? await post<{ message_id: string; thread_id: string }>(
            `/messages/${encodeURIComponent(msg.inReplyTo)}/reply`,
            { text: msg.text, headers: mailHeaders },
          )
        : await post<{ message_id: string; thread_id: string }>("/messages/send", {
            to: msg.to,
            subject: msg.subject,
            text: msg.text,
            headers: mailHeaders,
          });
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
  };
}
