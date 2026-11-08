/**
 * The four public tools (contracts/mcp.ts PUBLIC_TOOLS) that other companies' agents call, with
 * no person in the loop: get_readiness_score, get_quote, buy_audit and get_order_status. The
 * public MCP server (/api/mcp) and the A2A endpoint (/api/a2a) both call callPublicTool, so the
 * two protocols can't drift. No LLM runs here; every answer comes from code and Postgres.
 */
import { createHash } from "node:crypto";
import { and, count, eq, gte, sql } from "drizzle-orm";
import { PUBLIC_TOOLS, type PaidProductKey, type PublicToolName } from "../../contracts";
import { AGENT_PAYMENTS_ENABLED, PRODUCTS, PUBLIC_BUY_LIMIT_PER_HOUR } from "../constants";
import type { Db } from "../db/client";
import { events, orders, reports } from "../db/schema";
import { AppError, toAppError } from "../errors";
import type { Emit } from "../events";
import type { StripeGateway } from "../integrations/types";
import { checkoutFor, createOrder, getOrder, payWithSharedToken } from "../orders";
import type { ScanResult as SiteScan } from "../scan/contracts";

export type PublicProtocol = "mcp" | "a2a";

export interface PublicDeps {
  db: Db;
  emit: Emit;
  stripe: StripeGateway;
  appUrl: string;
  /** Matthew's scan service: score a domain for a caller (it rate-limits per caller). */
  scan: (domain: string, callerIp: string) => Promise<SiteScan>;
  /** Overrides AGENT_PAYMENTS_ENABLED; tests only. */
  agentPayments?: boolean;
}

export interface CallMeta {
  protocol: PublicProtocol;
  /** The caller's IP; only its hash is stored. */
  callerIp: string;
  requestId: string;
}

export const callerHash = (ip: string): string =>
  createHash("sha256").update(`outrun-public:${ip}`).digest("hex").slice(0, 32);

type Out<N extends PublicToolName> = (typeof PUBLIC_TOOLS)[N]["output"]["_output"];

/** Validates input, runs the tool, validates output and records the call. Throws AppError. */
export async function callPublicTool<N extends PublicToolName>(
  deps: PublicDeps,
  name: N,
  rawInput: unknown,
  meta: CallMeta,
): Promise<Out<N>> {
  const def = PUBLIC_TOOLS[name];
  if (!def) throw new AppError("not_found", `unknown tool ${String(name)}`);
  const caller = callerHash(meta.callerIp);
  let output: unknown;
  try {
    const parsed = def.input.safeParse(rawInput ?? {});
    if (!parsed.success) {
      const why = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
      throw new AppError("bad_request", why);
    }
    output = def.output.parse(
      await run(deps, name, parsed.data as Record<string, unknown>, { ...meta, caller }),
    );
  } catch (err) {
    const e = mapError(err);
    await record(deps, name, meta, caller, { ok: false, code: e.code });
    throw e;
  }
  await record(deps, name, meta, caller, { ok: true });
  return output as Out<N>;
}

async function record(
  deps: PublicDeps,
  tool: string,
  meta: CallMeta,
  caller: string,
  result: { ok: boolean; code?: string },
): Promise<void> {
  await deps
    .emit({
      actor: "web",
      type: "public.tool_called",
      entityType: "system",
      entityId: tool,
      payload: { tool, protocol: meta.protocol, caller, requestId: meta.requestId, ...result },
    })
    .catch(() => {});
}

function mapError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const e = err as { name?: string; message?: string } | undefined;
  if (e?.name === "RateLimitError") {
    return new AppError("rate_limited", "too many scans from this caller; try again in an hour", {
      retryAfterSeconds: 3600,
    });
  }
  if (
    /Expected a (public )?domain|Invalid URL|Only public|Invalid host|Private address/i.test(e?.message ?? "")
  ) {
    return new AppError("bad_request", e?.message ?? "bad domain");
  }
  return toAppError(err);
}

async function run(
  deps: PublicDeps,
  name: PublicToolName,
  input: Record<string, unknown>,
  meta: CallMeta & { caller: string },
): Promise<unknown> {
  switch (name) {
    case "get_readiness_score":
      return scoreFrom(deps.appUrl, await deps.scan(String(input.domain), meta.callerIp));
    case "get_quote": {
      const product = PRODUCTS[input.package as PaidProductKey];
      return {
        domain: input.domain,
        package: product.key,
        priceUsd: product.priceUsd,
        interval: product.interval,
        deliverables: [...product.deliverables],
      };
    }
    case "buy_audit":
      return buy(deps, input as unknown as BuyInput, meta);
    case "get_order_status":
      return status(deps, String(input.orderId));
  }
}

/** Maps the scanner's result onto the contract's ScoreResponse. Only the readiness checks count. */
export function scoreFrom(appUrl: string, r: SiteScan) {
  const checks = r.checks
    .filter((c) => c.category === "readiness")
    .map((c) => ({
      id: c.id.replace(/-/g, "_"),
      tier:
        c.weight >= 10 ? ("critical" as const) : c.weight >= 6 ? ("important" as const) : ("nice" as const),
      passed: c.status === "pass",
      title: c.label,
      evidence: c.evidence,
      weight: c.weight,
    }));
  return {
    domain: r.domain,
    score: Math.max(0, Math.min(100, Math.round(r.scores.siteReadiness.value ?? 0))),
    checks,
    reportUrl: new URL(r.reportUrl || `/score/${r.domain}`, appUrl).toString(),
    cachedAt: new Date(r.scannedAt).toISOString(),
  };
}

interface BuyInput {
  domain: string;
  package: PaidProductKey;
  contactEmail: string;
  idempotencyKey: string;
  sharedPaymentToken?: string;
}

async function buy(deps: PublicDeps, input: BuyInput, meta: CallMeta & { caller: string }) {
  // Keys are per caller, so one agent can never reach another's order by guessing its key.
  const key = `public:${meta.caller}:${input.idempotencyKey}`;
  const [existing] = await deps.db.select().from(orders).where(eq(orders.idempotencyKey, key));
  if (!existing) {
    // Repeating a key is always free; new orders are limited per caller per hour.
    const [recent] = await deps.db
      .select({ n: count() })
      .from(events)
      .where(
        and(
          eq(events.type, "public.order_created"),
          gte(events.ts, new Date(Date.now() - 3600_000)),
          sql`${events.payload}->>'caller' = ${meta.caller}`,
        ),
      );
    if (Number(recent?.n ?? 0) >= PUBLIC_BUY_LIMIT_PER_HOUR) {
      throw new AppError("rate_limited", "too many new orders from this caller; try again in an hour", {
        retryAfterSeconds: 3600,
      });
    }
  }
  const order = await createOrder(deps, {
    domain: input.domain,
    product: input.package,
    contactEmail: input.contactEmail,
    idempotencyKey: key,
    actor: "web",
  });
  if (!existing) {
    await deps.emit({
      actor: "web",
      type: "public.order_created",
      entityType: "order",
      entityId: order.id,
      payload: { caller: meta.caller, protocol: meta.protocol },
    });
  }
  // A repeat after payment gets the status page instead of a second checkout.
  if (order.state !== "pending")
    return { orderId: order.id, checkoutUrl: `${deps.appUrl}/orders/${order.id}` };
  // SR-12: pay with the agent's token when that's on and the product is one-time; otherwise Checkout.
  const enabled = deps.agentPayments ?? AGENT_PAYMENTS_ENABLED;
  if (input.sharedPaymentToken && enabled && PRODUCTS[input.package].interval === "one_time") {
    await payWithSharedToken({ ...deps, agentPayments: enabled }, order, input.sharedPaymentToken);
    return { orderId: order.id, checkoutUrl: `${deps.appUrl}/orders/${order.id}` };
  }
  const { url } = await checkoutFor(deps, order);
  return { orderId: order.id, checkoutUrl: url };
}

async function status(deps: PublicDeps, orderId: string) {
  const order = await getOrder(deps.db, orderId);
  if (!order) throw new AppError("not_found", "order not found");
  let reportUrl: string | null = null;
  if (order.state === "delivered") {
    const [r] = await deps.db
      .select({ token: reports.accessToken })
      .from(reports)
      .where(eq(reports.orderId, order.id));
    if (r) reportUrl = `${deps.appUrl}/report/${r.token}`;
  }
  return { orderId: order.id, state: order.state, reportUrl, updatedAt: order.updatedAt.toISOString() };
}
