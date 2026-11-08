/**
 * Outrun's AgentMail use, with the key kept on this server: throwaway inboxes the agents sign up to
 * an app with, and the one inbox that sends each app's owner their summary. Agents never choose a
 * recipient or a body here: see send_summary in mcp.ts.
 */
const BASE = "https://api.agentmail.to/v0";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const key = process.env["AGENTMAIL_API_KEY"];
  if (!key) throw new Error("AGENTMAIL_API_KEY is not set on the app");
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(8_000),
  });
  if (!r.ok) throw new Error(`AgentMail ${path.split("?")[0]} answered ${r.status}`);
  return (await r.json()) as T;
}

/** A fresh inbox named after the app's host; returns its address. */
export async function createInbox(host: string): Promise<string> {
  const short =
    host
      .split(".")[0]
      ?.replace(/[^a-z0-9]/g, "")
      .slice(0, 20) || "app";
  const suffix = Math.random().toString(36).slice(2, 8);
  const r = await call<{ inbox_id: string }>("/inboxes", {
    method: "POST",
    body: JSON.stringify({ username: `outrun-${short}-${suffix}` }),
  });
  return r.inbox_id;
}

export interface InboxMessage {
  id: string;
  from: string;
  subject: string;
  text: string;
  received_at: string;
}

interface ListedMessage {
  message_id: string;
}

interface FullMessage {
  message_id: string;
  from?: string;
  subject?: string;
  text?: string;
  extracted_text?: string;
  html?: string;
  timestamp?: string;
  created_at?: string;
}

const inboxPath = (inbox: string): string => `/inboxes/${encodeURIComponent(inbox)}/messages`;

/** The five newest messages, full text, so a verification link can be followed. */
export async function readInbox(inbox: string): Promise<InboxMessage[]> {
  const { messages } = await call<{ messages: ListedMessage[] }>(`${inboxPath(inbox)}?limit=5`);
  const full = await Promise.all(
    messages.map((m) => call<FullMessage>(`${inboxPath(inbox)}/${encodeURIComponent(m.message_id)}`)),
  );
  return full.map((m) => ({
    id: m.message_id,
    from: m.from ?? "",
    subject: m.subject ?? "",
    text: (m.text ?? m.extracted_text ?? m.html ?? "").slice(0, 8_000),
    received_at: m.timestamp ?? m.created_at ?? "",
  }));
}

export async function createSummaryInbox(): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const r = await call<{ inbox_id: string }>("/inboxes", {
    method: "POST",
    body: JSON.stringify({ username: `outrun-summaries-${suffix}`, display_name: "Outrun" }),
  });
  return r.inbox_id;
}

export async function sendMail(from: string, to: string, subject: string, text: string): Promise<void> {
  await call(`${inboxPath(from)}/send`, {
    method: "POST",
    body: JSON.stringify({ to: [to], subject, text }),
  });
}
