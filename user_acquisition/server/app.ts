/**
 * The deployed app's whole server: one function behind `/api/app`. The host rewrites `/mcp`,
 * `/u/<token>`, `/api/enter`, `/api/health` and `/` to it, stating the original path in `__path`.
 */
import { enter, gatePage, leadsPage, signedIn } from "./dashboard.ts";
import { addSuppression, emailForToken, openDb, type Db } from "./db.ts";
import { authorized, handleMcp } from "./mcp.ts";
import { confirmPage, donePage, TOKEN_PATTERN, unknownPage } from "./unsubscribe.ts";

interface Request {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

interface Reply {
  status(code: number): Reply;
  json(body: unknown): void;
  end(body?: string): void;
  setHeader(name: string, value: string): void;
}

function header(req: Request, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function pathOf(req: Request): string {
  const url = new URL(req.url ?? "/", "http://app");
  const path = url.searchParams.get("__path") ?? url.pathname;
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function rawBody(req: Request): string {
  if (req.body === undefined || req.body === null) return "";
  return typeof req.body === "string" ? req.body : JSON.stringify(req.body);
}

function originOf(req: Request): string {
  const configured = process.env["OUTREACH_PUBLIC_URL"];
  if (configured) return configured.replace(/\/+$/, "");
  const host = header(req, "x-forwarded-host") ?? header(req, "host") ?? "localhost";
  return `https://${host}`;
}

const html = (res: Reply, status: number, body: string): void => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("referrer-policy", "no-referrer");
  res.status(status).end(body);
};

export default async function handler(req: Request, res: Reply): Promise<void> {
  let client: Db | null = null;
  const db = async (): Promise<Db> => {
    if (client === null) client = await openDb();
    return client;
  };
  const method = (req.method ?? "GET").toUpperCase();
  const path = pathOf(req);

  try {
    if (path === "/mcp") {
      if (method !== "POST") return void res.status(405).json({ error: "POST only" });
      if (!authorized(header(req, "authorization"), process.env["VETTA_MCP_TOKEN"])) {
        return void res.status(401).json({ error: "missing or invalid bearer token" });
      }
      const answer = await handleMcp(rawBody(req), {
        db,
        unsubscribeSecret: process.env["UNSUBSCRIBE_SECRET"] || null,
        mailingAddress: process.env["OUTREACH_MAILING_ADDRESS"] || null,
        origin: originOf(req),
      });
      return void (answer === null ? res.status(202).end() : res.status(200).json(answer));
    }

    const unsubscribe = /^\/u\/([^/]+)$/.exec(path);
    if (unsubscribe !== null) {
      const token = unsubscribe[1] ?? "";
      if (!TOKEN_PATTERN.test(token)) return html(res, 404, unknownPage());
      const email = await emailForToken(await db(), token);
      if (email === null) return html(res, 404, unknownPage());
      if (method === "GET") return html(res, 200, confirmPage(token));
      if (method === "POST") {
        await addSuppression(await db(), { email, reason: "unsubscribe", source: "link" });
        return html(res, 200, donePage());
      }
      return void res.status(405).json({ error: "GET or POST only" });
    }

    if (path === "/api/health") {
      await (await db()).query("select 1");
      return void res.status(200).json({
        ok: true,
        unsubscribe_configured: Boolean(process.env["UNSUBSCRIBE_SECRET"]),
        mcp_configured: Boolean(process.env["VETTA_MCP_TOKEN"]),
        dashboard_configured: Boolean(process.env["DASHBOARD_TOKEN"]),
      });
    }

    if (path === "/api/enter") {
      if (method !== "POST") return void res.status(405).json({ error: "POST only" });
      const result = enter(rawBody(req), process.env["DASHBOARD_TOKEN"], process.env["DASHBOARD_PASSWORD"]);
      if (result.cookie !== null) res.setHeader("set-cookie", result.cookie);
      res.setHeader("location", result.location);
      res.setHeader("cache-control", "no-store");
      return void res.status(result.status).end();
    }

    if (path === "/") {
      if (method !== "GET") return void res.status(405).json({ error: "GET only" });
      if (!signedIn(header(req, "cookie"), process.env["DASHBOARD_TOKEN"])) {
        const denied = new URL(req.url ?? "/", "http://app").searchParams.get("entry") === "denied";
        return html(res, 200, gatePage(denied, process.env["OUTREACH_STUDIO_URL"] || null));
      }
      return html(res, 200, await leadsPage(await db()));
    }

    return void res.status(404).json({ error: "not found" });
  } catch (error) {
    // The driver's message can name the database host, so it's logged and never sent.
    console.error(error);
    return void res.status(503).json({ error: "temporarily unavailable" });
  } finally {
    const open = client as Db | null;
    if (open !== null) await open.end().catch(() => {});
  }
}
