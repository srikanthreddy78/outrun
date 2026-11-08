/**
 * Every outside integration and every cross-track interface, as a TypeScript interface.
 * Real implementations live in src/integrations/<name>.ts (each owned by one track);
 * fakes live in src/fakes. Tests and dev without a key use the fakes.
 */
import type { AgentName, Domain, PaidProductKey, ScanCheck, StopReason } from "../../contracts";

/* ---------- LLM providers (Srikanth) ---------- */
export interface LlmRequest {
  model: string;
  system?: string;
  input: string;
  /** JSON Schema the reply must match. */
  jsonSchema: { name: string; schema: Record<string, unknown> };
  signal?: AbortSignal;
}
export interface LlmResult {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** When the provider reports it (OpenRouter does). */
  costUsd?: number;
}
export interface LlmProvider {
  readonly name: "openai" | "openrouter" | "fake";
  complete(req: LlmRequest): Promise<LlmResult>;
}

/* ---------- Naive (Srikanth, SR-6) ---------- */
export interface NaivePendingAction {
  kind: "tool" | "question";
  toolCallId: string;
  /** As Naive names it: `outrun.send_email`. */
  tool: string;
  input: unknown;
}
export interface NaiveSession {
  id: string;
  agentId: string;
  /** queued | running | idle | cancelled | terminated, as Naive reports it. */
  status: string;
  stopReason: StopReason | null;
  pendingActions: NaivePendingAction[];
  metadata: Record<string, unknown>;
  consumedUsd: number;
}
export interface NaiveClient {
  startSession(req: {
    agentId: string;
    message: string;
    metadata: Record<string, unknown>;
    idempotencyKey: string;
  }): Promise<{ sessionId: string }>;
  send(sessionId: string, message: string, idempotencyKey: string): Promise<void>;
  confirmTool(
    sessionId: string,
    toolCallId: string,
    decision: "allow" | "deny",
    reason: string,
  ): Promise<void>;
  getSession(sessionId: string): Promise<NaiveSession>;
  agentSpendUsd(agentId: string): Promise<number>;
  resolveAgentId(agent: AgentName): Promise<string>;
}

/* ---------- Stripe (Srikanth, SR-8) ---------- */
export interface StripeGateway {
  createCheckout(req: {
    orderId: string;
    product: PaidProductKey;
    customerEmail: string;
    successUrl: string;
    cancelUrl: string;
    idempotencyKey: string;
  }): Promise<{ checkoutId: string; url: string }>;
}

/* ---------- Readiness scanner (Matthew, MT-2) ---------- */
export interface ScanResult {
  domain: Domain;
  score: number;
  checks: ScanCheck[];
  scannerVersion: string;
}
export type ScanDomainFn = (domain: Domain) => Promise<ScanResult>;

/* ---------- Apify (Matthew, MT-6) ---------- */
export interface ApifyClient {
  runActor(req: {
    actorId: string;
    input: Record<string, unknown>;
    webhookUrl: string;
    idempotencyKey: string;
  }): Promise<{
    runId: string;
    datasetId: string;
  }>;
  getDataset(
    datasetId: string,
    opts: { offset: number; limit: number },
  ): Promise<{
    items: { url: string; title: string; text: string }[];
    total: number;
  }>;
}

/* ---------- Discovery and enrichment (Shane, SH-2/SH-3) ---------- */
export interface DiscoveredCompany {
  domain: Domain;
  name: string;
  source: "mcp_registry" | "glama" | "apify" | "producthunt" | "yc" | "fixture";
  sourceRef: string;
  summary: string;
}
export type DiscoverFn = (opts: { limit: number; icp?: string }) => Promise<DiscoveredCompany[]>;
export interface EnrichResult {
  facts: { key: string; value: string; sourceUrl: string }[];
  contacts: { name: string; role: string; email: string; sourceUrl: string }[];
  costUsd: number;
}
export type EnrichFn = (domain: Domain) => Promise<EnrichResult>;

/* ---------- Email (Shane, SH-1) ---------- */
export interface TransactionalEmail {
  to: string;
  subject: string;
  text: string;
  /** Dedupe key; the same key never sends twice. */
  idempotencyKey: string;
}
export type SendTransactionalFn = (msg: TransactionalEmail) => Promise<{ providerId: string }>;
export interface AgentMailClient {
  send(msg: {
    to: string;
    subject: string;
    text: string;
    threadId?: string;
    inReplyTo?: string;
    listUnsubscribe: string;
    idempotencyKey: string;
  }): Promise<{ providerId: string; threadId: string }>;
  sendTransactional: SendTransactionalFn;
}

/* ---------- HubSpot (Shane, SH-4) ---------- */
export interface HubSpotClient {
  upsertCompany(c: { outrunId: string; domain: string; name: string }): Promise<{ id: string }>;
  upsertContact(c: {
    outrunId: string;
    email: string;
    name: string;
    companyId: string;
  }): Promise<{ id: string }>;
  upsertDeal(d: {
    outrunId: string;
    name: string;
    stage: string;
    companyId: string;
  }): Promise<{ id: string }>;
  logEmail(e: {
    dealId: string;
    subject: string;
    body: string;
    direction: "outbound" | "inbound";
    at: string;
  }): Promise<void>;
}

/* ---------- Monid (Shane, SH-3) ---------- */
export interface MonidClient {
  run(endpoint: string, input: Record<string, unknown>): Promise<{ data: unknown; costUsd: number }>;
}

export interface Integrations {
  llm: { openai: LlmProvider; openrouter: LlmProvider };
  naive: NaiveClient;
  stripe: StripeGateway;
  scanDomain: ScanDomainFn;
  apify: ApifyClient;
  discover: DiscoverFn;
  enrich: EnrichFn;
  agentmail: AgentMailClient;
  sendTransactional: SendTransactionalFn;
  hubspot: HubSpotClient;
  monid: MonidClient;
}
