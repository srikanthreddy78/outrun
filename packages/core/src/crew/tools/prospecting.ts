/**
 * The prospector's and researcher's tools (SH-2, SH-3).
 *
 *   list_candidates  companies from the sources that aren't prospects or suppressed
 *   file_prospect    dedupes by domain, checks suppression and the discovery cap, then
 *                    enqueues the scan and the CRM sync
 *   get_prospect     company, latest scan and saved facts
 *   enrich_company   Monid lookups (paid); returns sourced facts, saves nothing
 *   save_research    sourced facts and business contacts only; code computes the fit score
 */
import { randomUUID } from "node:crypto";
import { and, asc, count, eq, gte, isNull, or, sql } from "drizzle-orm";
import { untrusted } from "../../../contracts";
import { CRON_TZ, OUTRUN_CLIENT_ID } from "../../constants";
import { confirmedClient } from "../../clients";
import { clientCandidates, companies, contacts, prospects, suppressions } from "../../db/schema";
import { assertDemoDiscovery } from "../../demo";
import { isSuppressed } from "../../email/rules";
import { AppError } from "../../errors";
import type { EnrichFn } from "../../integrations/types";
import { FREE_MAIL, scoreClientFit, scoreFit } from "../../scoring/fit";
import { notProspectOf } from "../../sources/clientSources";
import { startOfDayIn } from "../../time";
import { defineTool } from "../registry";
import { latestChecks } from "./outreach";

export interface ProspectingDeps {
  settings: { discoveryDailyCap: number; demo: boolean };
  enrich: EnrichFn;
}

export const listCandidates = (deps: ProspectingDeps) =>
  defineTool({
    name: "list_candidates",
    handler: async ({ limit, source }, ctx) => {
      // Another client's candidates are the ones its own sources found for it.
      if (ctx.clientId !== OUTRUN_CLIENT_ID) {
        if (source && source !== "hunter") return { candidates: [] };
        const rows = await ctx.db
          .select({
            companyId: companies.id,
            domain: companies.domain,
            name: companies.name,
            source: clientCandidates.source,
            summary: companies.summary,
            reason: clientCandidates.reason,
          })
          .from(clientCandidates)
          .innerJoin(companies, eq(clientCandidates.companyId, companies.id))
          .where(
            and(
              eq(clientCandidates.clientId, ctx.clientId),
              notProspectOf(ctx.clientId),
              sql`not exists (select 1 from ${suppressions} s where s.value = ${companies.domain} and (s.client_id is null or s.client_id = ${ctx.clientId}))`,
            ),
          )
          .orderBy(asc(clientCandidates.createdAt))
          .limit(limit);
        return {
          candidates: rows.map(({ reason, ...r }) => ({
            ...r,
            name: r.name ?? r.domain,
            summary: untrusted([r.summary, reason].filter(Boolean).join(" · ")),
          })),
        };
      }
      const rows = await ctx.db
        .select({
          companyId: companies.id,
          domain: companies.domain,
          name: companies.name,
          source: companies.source,
          summary: companies.summary,
        })
        .from(companies)
        .leftJoin(prospects, and(eq(prospects.companyId, companies.id), eq(prospects.clientId, ctx.clientId)))
        .where(
          and(
            eq(companies.kind, "candidate"),
            isNull(prospects.id),
            ...(deps.settings.demo ? [eq(companies.source, "fixture")] : []),
            ...(source ? [eq(companies.source, source)] : []),
            sql`not exists (select 1 from ${suppressions} s where s.value = ${companies.domain})`,
          ),
        )
        .orderBy(asc(companies.createdAt))
        .limit(limit);
      return { candidates: rows.map((r) => ({ ...r, summary: untrusted(r.summary) })) };
    },
  });

export const fileProspect = (deps: ProspectingDeps) =>
  defineTool({
    name: "file_prospect",
    handler: async ({ companyId, reason }, ctx) => {
      const [co] = await ctx.db.select().from(companies).where(eq(companies.id, companyId));
      const outrun = ctx.clientId === OUTRUN_CLIENT_ID;
      if (!co) throw new AppError("not_found", "no such candidate");
      // A client files only what its own sources found for it.
      if (!outrun) {
        const [mine] = await ctx.db
          .select({ id: clientCandidates.id })
          .from(clientCandidates)
          .where(and(eq(clientCandidates.clientId, ctx.clientId), eq(clientCandidates.companyId, co.id)));
        if (!mine) throw new AppError("not_found", "no such candidate");
      }
      assertDemoDiscovery(deps.settings, co.source);
      const [existing] = await ctx.db
        .select({ id: prospects.id })
        .from(prospects)
        .where(and(eq(prospects.companyId, co.id), eq(prospects.clientId, ctx.clientId)));
      if (existing) return { prospectId: existing.id, status: "duplicate" as const };
      const [blocked] = await ctx.db
        .select({ id: suppressions.id })
        .from(suppressions)
        .where(
          and(
            eq(suppressions.value, co.domain),
            or(isNull(suppressions.clientId), eq(suppressions.clientId, ctx.clientId)),
          ),
        );
      if (blocked) throw new AppError("forbidden", `${co.domain} is suppressed`);
      const [{ n }] = (await ctx.db
        .select({ n: count() })
        .from(prospects)
        .where(
          and(
            eq(prospects.clientId, ctx.clientId),
            gte(prospects.createdAt, startOfDayIn(CRON_TZ, ctx.now())),
            eq(prospects.isDemo, false),
          ),
        )) as [{ n: number }];
      if (n >= deps.settings.discoveryDailyCap)
        throw new AppError("rate_limited", "today's discovery cap is used; file more tomorrow", {
          retryAfterSeconds: 3600,
        });

      const [p] = await ctx.db
        .insert(prospects)
        .values({ clientId: ctx.clientId, companyId: co.id, filedReason: reason })
        .onConflictDoNothing({ target: [prospects.clientId, prospects.companyId] })
        .returning({ id: prospects.id });
      if (!p) {
        const [again] = await ctx.db
          .select({ id: prospects.id })
          .from(prospects)
          .where(and(eq(prospects.companyId, co.id), eq(prospects.clientId, ctx.clientId)));
        return { prospectId: again!.id, status: "duplicate" as const };
      }
      // Outrun's prospects get the readiness scan and the HubSpot mirror; a client's don't.
      if (outrun) {
        await ctx.db.update(companies).set({ kind: "prospect" }).where(eq(companies.id, co.id));
        await ctx.enqueue({
          type: "scan_domain",
          payload: { domain: co.domain, prospectId: p.id },
          idempotencyKey: `scan:filed:${p.id}`,
          traceId: randomUUID(),
        });
        await ctx.enqueue({
          type: "sync_crm",
          payload: { prospectId: p.id },
          idempotencyKey: `crm:${p.id}:filed`,
          traceId: randomUUID(),
        });
      }
      await ctx.emit({
        actor: `naive:${ctx.agent}`,
        type: "prospect.filed",
        entityType: "prospect",
        entityId: p.id,
        payload: { domain: co.domain, source: co.source },
      });
      return { prospectId: p.id, status: "filed" as const };
    },
  });

/** A prospect of this client's, with its company; another client's prospect is not found. */
async function prospectWithCompany(
  db: Parameters<typeof latestChecks>[0],
  prospectId: string,
  clientId: string,
) {
  const [r] = await db
    .select({
      p: prospects,
      domain: companies.domain,
      name: companies.name,
      source: companies.source,
      summary: companies.summary,
    })
    .from(prospects)
    .innerJoin(companies, eq(prospects.companyId, companies.id))
    .where(and(eq(prospects.id, prospectId), eq(prospects.clientId, clientId)));
  if (!r) throw new AppError("not_found", `prospect ${prospectId}`);
  return r;
}

export const getProspect = defineTool({
  name: "get_prospect",
  handler: async ({ prospectId }, ctx) => {
    const r = await prospectWithCompany(ctx.db, prospectId, ctx.clientId);
    const scan = await latestChecks(ctx.db, r.domain);
    return {
      prospect: { id: r.p.id, stage: r.p.stage, fitScore: r.p.fitScore, gapScore: r.p.gapScore },
      company: { domain: r.domain, name: r.name },
      scan: scan ? { id: scan.scanId, score: scan.score, checks: scan.checks } : null,
      facts: r.p.facts,
    };
  },
});

/** A business address at the prospect's own domain; never free mail or a guess at another domain. */
export function contactProblem(email: string, domain: string): string | null {
  const e = email.toLowerCase();
  if (FREE_MAIL.test(e)) return `${e} is a free-mail address; save business addresses only`;
  const host = e.split("@")[1] ?? "";
  if (host !== domain && !host.endsWith(`.${domain}`)) return `${e} isn't at ${domain}`;
  return null;
}

export const enrichCompany = (deps: ProspectingDeps) =>
  defineTool({
    name: "enrich_company",
    handler: async ({ prospectId }, ctx) => {
      const r = await prospectWithCompany(ctx.db, prospectId, ctx.clientId);
      if (deps.settings.demo && !r.p.isDemo)
        throw new AppError("forbidden", "demo mode: enrich only the demo prospect");
      const out = await deps.enrich(r.domain);
      await ctx.emit({
        actor: `naive:${ctx.agent}`,
        type: "enrich.ran",
        entityType: "prospect",
        entityId: prospectId,
        payload: { costUsd: out.costUsd, facts: out.facts.length, contacts: out.contacts.length },
      });
      return {
        facts: out.facts,
        contacts: out.contacts.filter((c) => !contactProblem(c.email, r.domain)),
      };
    },
  });

export const saveResearch = defineTool({
  name: "save_research",
  handler: async ({ prospectId, facts, contacts: found }, ctx) => {
    const r = await prospectWithCompany(ctx.db, prospectId, ctx.clientId);
    const problems = found.map((c) => contactProblem(c.email, r.domain)).filter(Boolean) as string[];
    if (problems.length) throw new AppError("bad_request", problems.join("; "));
    for (const f of facts)
      if (!/^https?:\/\//i.test(f.sourceUrl))
        throw new AppError("bad_request", `fact ${f.key} needs an http(s) sourceUrl`);

    // Merge with what's saved: one row per key and value.
    const merged = [...r.p.facts];
    for (const f of facts)
      if (!merged.some((m) => m.key === f.key && m.value === f.value))
        merged.push({ key: f.key, value: f.value, sourceUrl: f.sourceUrl });

    let savedContacts = 0;
    let first: { id: string; email: string; role: string } | null = null;
    for (const c of found) {
      if (await isSuppressed(ctx.db, c.email, ctx.clientId)) continue;
      const [row] = await ctx.db
        .insert(contacts)
        .values({
          companyId: r.p.companyId,
          name: c.name,
          role: c.role,
          email: c.email,
          sourceUrl: c.sourceUrl,
        })
        .onConflictDoUpdate({
          target: contacts.email,
          set: { name: c.name, role: c.role, sourceUrl: c.sourceUrl },
        })
        .returning({
          id: contacts.id,
          email: contacts.email,
          role: contacts.role,
          companyId: contacts.companyId,
        });
      if (!row || row.companyId !== r.p.companyId) continue;
      savedContacts++;
      first ??= row;
    }
    let contact = first;
    if (r.p.contactId && !first) {
      const [c] = await ctx.db.select().from(contacts).where(eq(contacts.id, r.p.contactId));
      if (c) contact = { id: c.id, email: c.email, role: c.role };
    }
    const client = await confirmedClient(ctx.db, ctx.clientId);
    const fitInput = { source: r.source, summary: r.summary ?? "", facts: merged, contact };
    const fit = client ? scoreClientFit(client.profile.icp, fitInput) : scoreFit(fitInput);
    const scan = await latestChecks(ctx.db, r.domain);
    await ctx.db
      .update(prospects)
      .set({
        facts: merged,
        fitScore: fit.score,
        ...(scan ? { gapScore: Math.max(0, 100 - scan.score) } : {}),
        ...(!r.p.contactId && first ? { contactId: first.id } : {}),
        ...(r.p.stage === "filed" ? { stage: "researched" as const } : {}),
      })
      .where(eq(prospects.id, prospectId));
    await ctx.emit({
      actor: `naive:${ctx.agent}`,
      type: "prospect.researched",
      entityType: "prospect",
      entityId: prospectId,
      payload: { fitScore: fit.score, parts: fit.parts, facts: merged.length, contacts: savedContacts },
    });
    if (ctx.clientId === OUTRUN_CLIENT_ID)
      await ctx.enqueue({
        type: "sync_crm",
        payload: { prospectId },
        idempotencyKey: `crm:${prospectId}:researched:${merged.length}:${savedContacts}`,
        traceId: randomUUID(),
      });
    return { fitScore: fit.score, savedFacts: merged.length, savedContacts };
  },
});

export const prospectingTools = (deps: ProspectingDeps) => [
  listCandidates(deps),
  fileProspect(deps),
  getProspect,
  enrichCompany(deps),
  saveResearch,
];
