/**
 * Fakes for the other integrations and the cross-track interfaces. Each records its calls
 * and returns deterministic data, so tests and dev runs need no keys and spend nothing.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Domain, PaidProductKey, ScanCheck } from "../../contracts";
import { PRODUCTS } from "../constants";
import { AppError } from "../errors";
import type {
  AgentMailClient,
  ApifyClient,
  DiscoverFn,
  DiscoveredCompany,
  EnrichFn,
  HubSpotClient,
  MonidClient,
  ScanDomainFn,
  SendTransactionalFn,
  StripeGateway,
  TransactionalEmail,
} from "../integrations/types";

const h = (s: string) => createHash("sha256").update(s).digest("hex");

export class FakeStripe implements StripeGateway {
  readonly checkouts: { orderId: string; product: PaidProductKey; amountUsd: number; checkoutId: string }[] =
    [];
  private readonly byKey = new Map<string, { checkoutId: string; url: string }>();
  async createCheckout(req: Parameters<StripeGateway["createCheckout"]>[0]) {
    const hit = this.byKey.get(req.idempotencyKey);
    if (hit) return hit;
    const checkoutId = `cs_test_fake_${h(req.idempotencyKey).slice(0, 16)}`;
    const out = { checkoutId, url: `https://checkout.stripe.test/c/${checkoutId}` };
    this.checkouts.push({
      orderId: req.orderId,
      product: req.product,
      amountUsd: PRODUCTS[req.product].priceUsd,
      checkoutId,
    });
    this.byKey.set(req.idempotencyKey, out);
    return out;
  }

  /** Token payments. `spt_declined…` is declined, as a card error would be. */
  readonly tokenPayments: {
    orderId: string;
    product: PaidProductKey;
    amountUsd: number;
    paymentIntentId: string;
  }[] = [];
  private readonly piByKey = new Map<string, { paymentIntentId: string; status: string }>();
  async payWithSharedToken(req: Parameters<StripeGateway["payWithSharedToken"]>[0]) {
    const hit = this.piByKey.get(req.idempotencyKey);
    if (hit) return hit;
    if (PRODUCTS[req.product].interval !== "one_time")
      throw new AppError("bad_request", "a subscription is paid through Checkout");
    if (req.token.startsWith("spt_declined"))
      throw new AppError("bad_request", "stripe StripeCardError (card_declined)");
    const out = {
      paymentIntentId: `pi_test_fake_${h(req.idempotencyKey).slice(0, 16)}`,
      status: "succeeded",
    };
    this.tokenPayments.push({
      orderId: req.orderId,
      product: req.product,
      amountUsd: PRODUCTS[req.product].priceUsd,
      paymentIntentId: out.paymentIntentId,
    });
    this.piByKey.set(req.idempotencyKey, out);
    return out;
  }
}

/** Deterministic scan: the same domain always gets the same checks. */
export const FAKE_CHECK_IDS = [
  "ssr_answer",
  "markdown_alternate",
  "llms_txt",
  "robots_ai_rules",
  "sitemap",
  "json_ld",
  "mcp_endpoint",
  "openapi_json",
] as const;
export function createFakeScan(calls: Domain[] = []): ScanDomainFn & { calls: Domain[] } {
  const fn = (async (domain: Domain) => {
    calls.push(domain);
    const seed = parseInt(h(domain).slice(0, 8), 16);
    const checks: ScanCheck[] = FAKE_CHECK_IDS.map((id, i) => ({
      id,
      tier: i < 3 ? "critical" : i < 6 ? "important" : "nice",
      passed: ((seed >> i) & 1) === 1,
      title: id.replace(/_/g, " "),
      evidence: `fake evidence for ${id} on ${domain}`,
      weight: i < 3 ? 15 : i < 6 ? 10 : 5,
    }));
    const total = checks.reduce((a, c) => a + c.weight, 0);
    const got = checks.filter((c) => c.passed).reduce((a, c) => a + c.weight, 0);
    return { domain, score: Math.round((got / total) * 100), checks, scannerVersion: "fake-1" };
  }) as ScanDomainFn & { calls: Domain[] };
  fn.calls = calls;
  return fn;
}

export class FakeApify implements ApifyClient {
  readonly runs: { runId: string; input: Record<string, unknown> }[] = [];
  constructor(private readonly pages: { url: string; title: string; text: string }[] = defaultPages()) {}
  async runActor(req: Parameters<ApifyClient["runActor"]>[0]) {
    const runId = `run_fake_${h(req.idempotencyKey).slice(0, 12)}`;
    if (!this.runs.some((r) => r.runId === runId)) this.runs.push({ runId, input: req.input });
    return { runId, datasetId: `ds_${runId}` };
  }
  async getDataset(_id: string, opts: { offset: number; limit: number }) {
    return { items: this.pages.slice(opts.offset, opts.offset + opts.limit), total: this.pages.length };
  }
}
function defaultPages() {
  return [
    { url: "https://demo.outrun.dev/", title: "Demo Co", text: "Demo Co builds APIs for agents." },
    {
      url: "https://demo.outrun.dev/docs",
      title: "Docs",
      text: "Quickstart: curl https://api.demo.outrun.dev",
    },
    { url: "https://demo.outrun.dev/pricing", title: "Pricing", text: "Contact sales." },
  ];
}

export function createFakeDiscover(companies: DiscoveredCompany[] = defaultCompanies()): DiscoverFn {
  return async ({ limit }) => companies.slice(0, limit);
}
function defaultCompanies(): DiscoveredCompany[] {
  return [
    {
      domain: "demo.outrun.dev",
      name: "Outrun Demo Co",
      source: "fixture",
      sourceRef: "fixture:1",
      summary: "MCP server for invoices",
    },
    {
      domain: "acme-agents.dev",
      name: "Acme Agents",
      source: "fixture",
      sourceRef: "fixture:2",
      summary: "Agent-native CRM API",
    },
    ...Array.from({ length: 48 }, (_, index) => ({
      domain: `fixture-agent-${index + 3}.dev`,
      name: `Fixture Agent ${index + 3}`,
      source: "fixture" as const,
      sourceRef: `fixture:${index + 3}`,
      summary: "Fixture API business",
    })),
  ];
}

export function createFakeEnrich(): EnrichFn {
  return async (domain) => ({
    facts: [{ key: "category", value: "developer tools", sourceUrl: `https://${domain}/` }],
    contacts: [
      {
        name: "Demo Founder",
        role: "Founder",
        email: `founder@${domain}`,
        sourceUrl: `https://${domain}/about`,
      },
    ],
    costUsd: 0,
  });
}

export class FakeAgentMail implements AgentMailClient {
  readonly sent: (Parameters<AgentMailClient["send"]>[0] & { providerId: string })[] = [];
  readonly transactional: (TransactionalEmail & { providerId: string })[] = [];
  async send(msg: Parameters<AgentMailClient["send"]>[0]) {
    const providerId = `am_fake_${h(msg.idempotencyKey).slice(0, 12)}`;
    if (!this.sent.some((s) => s.providerId === providerId)) this.sent.push({ ...msg, providerId });
    return { providerId, threadId: msg.threadId ?? `th_${providerId}` };
  }
  sendTransactional: SendTransactionalFn = async (msg) => {
    const providerId = `am_fake_tx_${h(msg.idempotencyKey).slice(0, 12)}`;
    if (!this.transactional.some((s) => s.providerId === providerId))
      this.transactional.push({ ...msg, providerId });
    return { providerId };
  };
}

export class FakeHubSpot implements HubSpotClient {
  readonly records = new Map<string, { kind: string; data: unknown }>();
  readonly emails: unknown[] = [];
  private up(kind: string, outrunId: string, data: unknown) {
    const key = `${kind}:${outrunId}`;
    this.records.set(key, { kind, data });
    return { id: `hs_${kind}_${h(key).slice(0, 8)}` };
  }
  async upsertCompany(c: Parameters<HubSpotClient["upsertCompany"]>[0]) {
    return this.up("company", c.outrunId, c);
  }
  async upsertContact(c: Parameters<HubSpotClient["upsertContact"]>[0]) {
    return this.up("contact", c.outrunId, c);
  }
  async upsertDeal(d: Parameters<HubSpotClient["upsertDeal"]>[0]) {
    return this.up("deal", d.outrunId, d);
  }
  async logEmail(e: Parameters<HubSpotClient["logEmail"]>[0]) {
    this.emails.push(e);
  }
}

export class FakeMonid implements MonidClient {
  readonly runs: { endpoint: string; input: Record<string, unknown> }[] = [];
  async run(endpoint: string, input: Record<string, unknown>) {
    this.runs.push({ endpoint, input });
    return { data: { endpoint, results: [] }, costUsd: 0 };
  }
}

export const fakeId = (): string => randomUUID();
