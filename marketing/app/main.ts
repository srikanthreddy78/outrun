/**
 * The studio app's server: one function behind /api/app, which the host rewrites `/`, `/c/<id>`,
 * `/api/enter`, `/api/health` and `/mcp` to, stating the original path in `__path`.
 */
import {
  commentsFor,
  findClient,
  insightsFor,
  listClients,
  mediaFor,
  openDb,
  postsFor,
  type Db,
} from "./db.ts";
import { handleMcp, sameSecret } from "./mcp.ts";
import { fileNames } from "./naive.ts";
import { clientPage, enter, gate, home, signedIn } from "./views.ts";

interface Req {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}
interface Res {
  status(code: number): Res;
  json(body: unknown): void;
  end(body?: string): void;
  setHeader(name: string, value: string): void;
}

const header = (req: Req, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};
const html = (res: Res, status: number, body: string): void => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("referrer-policy", "no-referrer");
  res.status(status).end(body);
};

export default async function handler(req: Req, res: Res): Promise<void> {
  let client: Db | null = null;
  const db = async (): Promise<Db> => (client ??= await openDb());
  const url = new URL(req.url ?? "/", "http://app");
  const path = (url.searchParams.get("__path") ?? url.pathname).replace(/\/+$/, "") || "/";
  const method = (req.method ?? "GET").toUpperCase();
  const raw =
    req.body === undefined || req.body === null
      ? ""
      : typeof req.body === "string"
        ? req.body
        : JSON.stringify(req.body);

  try {
    if (path === "/mcp") {
      if (method !== "POST") return void res.status(405).json({ error: "POST only" });
      const token = /^Bearer\s+(\S+)$/i.exec(header(req, "authorization") ?? "")?.[1];
      const mcpToken = process.env["VETTA_MCP_TOKEN"];
      if (!token || !mcpToken || !sameSecret(token, mcpToken))
        return void res.status(401).json({ error: "unauthorized" });
      const answer = await handleMcp(raw, db);
      return void (answer === null ? res.status(202).end() : res.status(200).json(answer));
    }
    if (path === "/api/health") {
      await (await db()).query("select 1");
      return void res.status(200).json({ ok: true });
    }
    if (path === "/api/enter") {
      if (method !== "POST") return void res.status(405).json({ error: "POST only" });
      const r = enter(raw, process.env["DASHBOARD_TOKEN"], process.env["DASHBOARD_PASSWORD"]);
      if (r.cookie) res.setHeader("set-cookie", r.cookie);
      res.setHeader("location", r.location);
      return void res.status(303).end();
    }
    if (!signedIn(header(req, "cookie"), process.env["DASHBOARD_TOKEN"])) {
      return html(res, 200, gate(url.searchParams.get("entry") === "denied"));
    }
    if (path === "/") return html(res, 200, home(await listClients(await db())));
    const detail = /^\/c\/([A-Za-z0-9_.-]+)$/.exec(path);
    if (detail) {
      const d = await db();
      const c = await findClient(d, detail[1] ?? "");
      if (!c) return html(res, 404, home(await listClients(d)));
      const media = await mediaFor(d, c.id);
      return html(
        res,
        200,
        clientPage({
          client: c as unknown as Record<string, unknown>,
          posts: await postsFor(d, c.id),
          comments: await commentsFor(d, c.id),
          insights: await insightsFor(d, c.id),
          media,
          fileNames: await fileNames(media.map((m) => String(m["file_id"]))),
        }),
      );
    }
    return void res.status(404).json({ error: "not found" });
  } catch (error) {
    console.error(error);
    return void res.status(503).json({ error: "temporarily unavailable" });
  } finally {
    const open = client as Db | null;
    if (open) await open.end().catch(() => {});
  }
}
