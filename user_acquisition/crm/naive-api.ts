/**
 * The Naive API calls the CRM sync makes: the app's database, the data tools used for
 * enrichment, and Naive's built-in CRM (contacts and their activity).
 */

export const API_VERSION = "2026-09-30";

export interface NaiveClient {
  baseUrl: string;
  apiKey: string;
}

export class NaiveApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function clientFromEnv(env: Record<string, string | undefined>): NaiveClient {
  const apiKey = env["NAIVE_API_KEY"];
  if (!apiKey) throw new Error("NAIVE_API_KEY is unset; put it in the repo root .env");
  return { apiKey, baseUrl: (env["NAIVE_API_URL"] ?? "https://api.vetta.sh").replace(/\/+$/, "") };
}

async function call<T>(
  client: NaiveClient,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  idempotencyKey?: string,
): Promise<T> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${client.apiKey}`,
    "vetta-version": API_VERSION,
    accept: "application/json",
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (idempotencyKey !== undefined) headers["idempotency-key"] = idempotencyKey;
  const response = await fetch(`${client.baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  const text = await response.text();
  const parsed: unknown = text === "" ? null : JSON.parse(text);
  if (!response.ok) {
    const error = (parsed as { error?: { code?: string; message?: string } } | null)?.error;
    throw new NaiveApiError(
      response.status,
      error?.code ?? "unknown",
      error?.message ?? `HTTP ${response.status}`,
    );
  }
  return parsed as T;
}

// ---- The app's database ------------------------------------------------------------------

/** Quotes a value for SQL with a dollar-quote tag that can't occur in the value. */
export function sqlLiteral(value: string | number | boolean | null | object): string {
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number in SQL");
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  let tag = "q";
  while (text.includes(`$${tag}$`)) tag += "q";
  return `$${tag}$${text}$${tag}$`;
}

export async function dbQuery<Row>(client: NaiveClient, appId: string, query: string): Promise<Row[]> {
  const result = await call<{ rows: Row[] }>(
    client,
    "POST",
    `/v1/apps/${encodeURIComponent(appId)}/db/query`,
    { query },
  );
  return result.rows;
}

// ---- Data tools -------------------------------------------------------------------------

export interface DataRun {
  status: string;
  cost_micro_usd: number;
  data: unknown;
  error: string | null;
}

export async function runDataTool(
  client: NaiveClient,
  toolId: string,
  query: Record<string, string>,
): Promise<DataRun> {
  return call<DataRun>(client, "POST", "/v1/data/runs", { tool_id: toolId, query });
}

// ---- CRM --------------------------------------------------------------------------------

export const CRM_STAGES = ["lead", "talking", "proposal", "won", "lost"] as const;
export type CrmStage = (typeof CRM_STAGES)[number];

export interface CrmContactInput {
  name: string;
  company?: string | null;
  email?: string | null;
  stage?: CrmStage;
  next_step?: string | null;
  source?: string | null;
}

export interface CrmContact extends Required<Pick<CrmContactInput, "name">> {
  id: string;
  company: string | null;
  email: string | null;
  stage: CrmStage;
  next_step: string | null;
  source: string | null;
  updated_at: string;
}

export interface CrmActivity {
  id: string;
  contact_id: string | null;
  kind: "note" | "email" | "call" | "meeting";
  body: string;
  at: string;
}

export async function findContactByEmail(client: NaiveClient, email: string): Promise<CrmContact | null> {
  const page = await call<{ data: CrmContact[] }>(
    client,
    "GET",
    `/v1/crm/contacts?q=${encodeURIComponent(email)}&limit=10`,
  );
  return page.data.find((contact) => contact.email?.toLowerCase() === email.toLowerCase()) ?? null;
}

export async function listContacts(client: NaiveClient): Promise<CrmContact[]> {
  const all: CrmContact[] = [];
  let after: string | null = null;
  do {
    const query = `limit=100${after === null ? "" : `&after=${encodeURIComponent(after)}`}`;
    const page: { data: CrmContact[]; has_more: boolean; next_cursor: string | null } = await call(
      client,
      "GET",
      `/v1/crm/contacts?${query}`,
    );
    all.push(...page.data);
    after = page.has_more ? page.next_cursor : null;
  } while (after !== null);
  return all;
}

export async function getContact(
  client: NaiveClient,
  id: string,
): Promise<CrmContact & { activity: CrmActivity[] }> {
  return call(client, "GET", `/v1/crm/contacts/${encodeURIComponent(id)}`);
}

export async function createContact(
  client: NaiveClient,
  input: CrmContactInput,
  idempotencyKey: string,
): Promise<CrmContact> {
  return call(client, "POST", "/v1/crm/contacts", input, idempotencyKey);
}

export async function updateContact(
  client: NaiveClient,
  id: string,
  patch: Partial<CrmContactInput>,
): Promise<CrmContact> {
  return call(client, "PATCH", `/v1/crm/contacts/${encodeURIComponent(id)}`, patch);
}

export async function deleteContact(client: NaiveClient, id: string): Promise<void> {
  await call(client, "DELETE", `/v1/crm/contacts/${encodeURIComponent(id)}`);
}

export async function addNote(
  client: NaiveClient,
  contactId: string,
  body: string,
  idempotencyKey: string,
): Promise<CrmActivity> {
  return call(
    client,
    "POST",
    "/v1/crm/activity",
    { contact_id: contactId, kind: "note", body },
    idempotencyKey,
  );
}
