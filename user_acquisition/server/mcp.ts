/**
 * The `/mcp` endpoint: the crew's tools, reached by an agent as `outreach.<tool>`.
 *
 * MCP streamable-HTTP is JSON-RPC over POST; the subset agents use (initialize, tools/list,
 * tools/call) is implemented by hand. The bearer is the one Naive mints for this app's agents
 * (`VETTA_MCP_TOKEN`); the platform API key is never an MCP credential.
 *
 * `prepare_email` is the first step of every send: it refuses suppressed addresses and returns the
 * final body with the one-click unsubscribe footer appended. The agent then sends that exact text
 * with Naive's own `email.send`, which waits for a person who sees the footer before approving.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import {
  addSuppression,
  findSuppression,
  listProspects,
  normalizeEmail,
  recordInbound,
  recordPrepared,
  saveProspect,
  saveUnsubscribeToken,
  type Db,
} from "./db.ts";
import { footer, tokenFor } from "./unsubscribe.ts";
import { normalizeDomain, verifyEmail, VerifyError } from "./verify.ts";

export interface McpContext {
  db: () => Promise<Db>;
  unsubscribeSecret: string | null;
  mailingAddress: string | null;
  origin: string;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

export const sameSecret = (a: string, b: string): boolean =>
  timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

export function authorized(authHeader: string | undefined, platformToken: string | undefined): boolean {
  const token = /^Bearer\s+(\S+)$/i.exec(authHeader ?? "")?.[1];
  return (
    token !== undefined &&
    platformToken !== undefined &&
    platformToken !== "" &&
    sameSecret(platformToken, token)
  );
}

const SUPPRESSION_REASONS = ["unsubscribe", "bounce", "complaint", "manual"] as const;
const INBOUND_KINDS = [
  "unsubscribe",
  "bounce",
  "complaint",
  "auto_reply",
  "human_reply",
  "spam",
  "other",
] as const;

const str = (description: string) => ({ type: "string", description }) as const;
const obj = (properties: Record<string, unknown>, required: string[]) =>
  ({ type: "object", properties, required }) as const;

export const TOOLS = [
  {
    name: "prepare_email",
    description:
      "Step one of every outreach email. Checks the recipient isn't unsubscribed, bounced or complained, and returns the final email with the one-click unsubscribe footer appended. Then send exactly the returned to, subject and text with email.send, changing nothing. Refused for a suppressed address: then send nothing.",
    inputSchema: obj(
      {
        to: str("One recipient address"),
        subject: str("Subject line"),
        text: str("Plain-text body, without any unsubscribe line"),
      },
      ["to", "subject", "text"],
    ),
  },
  {
    name: "is_suppressed",
    description: "Whether an address has unsubscribed, bounced or complained, and why.",
    inputSchema: obj({ email: str("Address to check") }, ["email"]),
  },
  {
    name: "suppress",
    description:
      "Stop all email to an address: an unsubscribe request, a hard bounce, a spam complaint, or a manual block. Idempotent.",
    inputSchema: obj(
      {
        email: str(
          "The address to stop emailing (for a bounce: the address that failed, not the mailer daemon)",
        ),
        reason: { type: "string", enum: SUPPRESSION_REASONS, description: "Why" },
        note: str("Optional: one short line on what the message said"),
      },
      ["email", "reason"],
    ),
  },
  {
    name: "save_prospect",
    description:
      "Save one prospect company with a verified contact email. Before saving, this tool fetches email_source_url itself and refuses unless the address appears on that page, is on the company's own domain (no free mail), and that domain has MX records. A refusal says why: fix it or move on to another company. One row per company domain.",
    inputSchema: obj(
      {
        company: str("Company name"),
        domain: str("The company's own website domain, e.g. example.com"),
        found_via: {
          type: "string",
          enum: [
            "mcp_registry",
            "glama",
            "smithery",
            "mcp_so",
            "apis_guru",
            "product_hunt",
            "yc",
            "hacker_news",
            "web_search",
            "other",
          ],
          description: "Where you found the company",
        },
        listing_url: str("The directory or listing page you found it on"),
        why_fit: str(
          "One sentence: what the company ships for agents or developers (an MCP server, a public API, a developer tool)",
        ),
        contact_email: str("The business email address, exactly as published"),
        contact_name: str("The person's name, when the page names one"),
        contact_role: str(
          "Their role (founder, CEO, CTO, DevRel, partnerships) or 'general inbox' for hello@/contact@",
        ),
        email_source_url: str("The public page whose HTML shows contact_email"),
      },
      ["company", "domain", "found_via", "why_fit", "contact_email", "email_source_url"],
    ),
  },
  {
    name: "list_prospects",
    description:
      "Every company already saved, with its domain and email. Read it first so you never research a company twice.",
    inputSchema: obj({}, []),
  },
  {
    name: "record_inbound",
    description:
      "Record that you handled one inbound message, before acting on it. Answers first_time false when it was already handled (by a wake or an earlier sweep); then do nothing more with it.",
    inputSchema: obj(
      {
        message_id: str("The message's id from email.read"),
        from: str("Sender address"),
        kind: { type: "string", enum: INBOUND_KINDS, description: "What the message is" },
        summary: str("At most twenty words, in your own words"),
      },
      ["message_id", "kind"],
    ),
  },
] as const;

class ToolError extends Error {}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function need(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.trim() === "") throw new ToolError(`${key} is required`);
  return value.trim();
}

function oneOf<T extends string>(params: Record<string, unknown>, key: string, allowed: readonly T[]): T {
  const value = need(params, key);
  if (!(allowed as readonly string[]).includes(value))
    throw new ToolError(`${key} must be one of ${allowed.join(", ")}`);
  return value as T;
}

function address(params: Record<string, unknown>, key: string): string {
  const value = normalizeEmail(need(params, key));
  if (!EMAIL.test(value)) throw new ToolError(`${key} is not an email address`);
  return value;
}

const optional = (params: Record<string, unknown>, key: string): string | null =>
  typeof params[key] === "string" && (params[key] as string).trim() !== ""
    ? (params[key] as string).trim()
    : null;

async function callTool(name: string, params: Record<string, unknown>, ctx: McpContext): Promise<unknown> {
  switch (name) {
    case "prepare_email": {
      const to = address(params, "to");
      const subject = need(params, "subject");
      const text = need(params, "text");
      if (ctx.unsubscribeSecret === null)
        throw new ToolError("not configured: UNSUBSCRIBE_SECRET is unset on the app");
      if (/unsubscribe/i.test(text))
        throw new ToolError("remove your own unsubscribe line from text; the footer adds the real one");

      const db = await ctx.db();
      const suppressed = await findSuppression(db, to);
      if (suppressed !== null) {
        throw new ToolError(
          `refused: ${to} is suppressed (${suppressed.reason}, since ${suppressed.createdAt}); send them nothing`,
        );
      }

      const token = tokenFor(ctx.unsubscribeSecret, to);
      await saveUnsubscribeToken(db, token, to);
      const unsubscribeUrl = `${ctx.origin}/u/${token}`;
      const body = `${text.trimEnd()}\n${footer(unsubscribeUrl, ctx.mailingAddress)}`;
      const id = createHash("sha256").update(`${to}\n${subject}\n${body}`).digest("hex").slice(0, 32);
      await recordPrepared(db, { id, to, subject });
      return {
        to,
        subject,
        text: body,
        unsubscribe_url: unsubscribeUrl,
        next: "send exactly this to, subject and text with email.send",
      };
    }
    case "is_suppressed": {
      const suppression = await findSuppression(await ctx.db(), address(params, "email"));
      return suppression === null
        ? { suppressed: false }
        : { suppressed: true, reason: suppression.reason, since: suppression.createdAt };
    }
    case "suppress": {
      const email = address(params, "email");
      const reason = oneOf(params, "reason", SUPPRESSION_REASONS);
      const note = optional(params, "note");
      const result = await addSuppression(await ctx.db(), {
        email,
        reason,
        source: "agent",
        ...(note === null ? {} : { note }),
      });
      return { suppressed: true, email, newly: result.created };
    }
    case "save_prospect": {
      const company = need(params, "company");
      const domain = normalizeDomain(need(params, "domain"));
      const sourceUrl = need(params, "email_source_url");
      const db = await ctx.db();
      const suppressed = await findSuppression(db, need(params, "contact_email"));
      if (suppressed !== null)
        throw new ToolError(
          `refused: that address is suppressed (${suppressed.reason}); pick another company`,
        );
      let verified;
      try {
        verified = await verifyEmail(need(params, "contact_email"), domain, sourceUrl);
      } catch (error) {
        if (error instanceof VerifyError) throw new ToolError(`not saved: ${error.message}`);
        throw error;
      }
      const saved = await saveProspect(db, {
        domain: verified.domain,
        company,
        foundVia: need(params, "found_via"),
        listingUrl: optional(params, "listing_url"),
        whyFit: need(params, "why_fit"),
        contactEmail: verified.email,
        contactName: optional(params, "contact_name"),
        contactRole: optional(params, "contact_role"),
        emailSourceUrl: sourceUrl,
        mxHost: verified.mxHost,
      });
      const total = (await listProspects(db)).length;
      return saved.created
        ? {
            saved: true,
            domain: verified.domain,
            email: verified.email,
            mx: verified.mxHost,
            total_saved: total,
          }
        : { saved: false, reason: `${verified.domain} was already saved`, total_saved: total };
    }
    case "list_prospects": {
      const rows = await listProspects(await ctx.db());
      return { total: rows.length, prospects: rows };
    }
    case "record_inbound": {
      const messageId = need(params, "message_id");
      const kind = oneOf(params, "kind", INBOUND_KINDS);
      const result = await recordInbound(await ctx.db(), {
        messageId,
        from: optional(params, "from"),
        kind,
        summary: optional(params, "summary"),
      });
      return { recorded: true, first_time: result.firstTime };
    }
    default:
      throw new ToolError(`unknown tool ${name}`);
  }
}

const rpcResult = (id: JsonRpcRequest["id"], result: unknown) => ({ jsonrpc: "2.0", id: id ?? null, result });
const rpcError = (id: JsonRpcRequest["id"], code: number, message: string) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message },
});

/** One JSON-RPC message in, its reply out; `null` for a notification, which gets no reply. */
export async function handleMcp(raw: string, ctx: McpContext): Promise<object | null> {
  let msg: JsonRpcRequest;
  try {
    msg = JSON.parse(raw) as JsonRpcRequest;
  } catch {
    return rpcError(null, -32700, "parse error");
  }
  if (typeof msg.method !== "string") return rpcError(msg.id, -32600, "invalid request");
  if (msg.method.startsWith("notifications/")) return null;
  if (msg.method === "initialize") {
    return rpcResult(msg.id, {
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "outreach", version: "0.1.0" },
    });
  }
  if (msg.method === "ping") return rpcResult(msg.id, {});
  if (msg.method === "tools/list") return rpcResult(msg.id, { tools: TOOLS });
  if (msg.method === "tools/call") {
    const { name, arguments: args } = (msg.params ?? {}) as {
      name?: string;
      arguments?: Record<string, unknown>;
    };
    try {
      const result = await callTool(name ?? "", args ?? {}, ctx);
      return rpcResult(msg.id, { content: [{ type: "text", text: JSON.stringify(result) }] });
    } catch (error) {
      if (error instanceof ToolError)
        return rpcResult(msg.id, { content: [{ type: "text", text: error.message }], isError: true });
      throw error;
    }
  }
  return rpcError(msg.id, -32601, "method not found");
}
