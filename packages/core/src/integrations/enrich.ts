/**
 * SH-3: enrich() on Monid's akta company enrichment. Every fact keeps a source URL (akta's own
 * source, or the company site). akta lists people by name and title but never their email, so
 * contacts come back empty; the researcher finds business addresses on the company's own pages.
 */
import { ENRICH_ENDPOINT, ENRICH_SECTIONS } from "../constants";
import type { EnrichFn, EnrichResult, MonidClient } from "./types";

type Coded = { code?: string; label?: string };
interface Akta {
  firmographic?: {
    name?: string;
    website?: string;
    founded_year?: number;
    company_description_short?: string;
    headcount_range?: string;
    company_type?: Coded;
    ownership_category?: Coded;
    operating_status?: Coded;
  };
  customer_profile?: { segment?: { title?: string; is_primary?: boolean; source?: string[] }[] };
  management_profile?: { profiles?: { name?: string; designation?: string; source?: string[] }[] };
}

const httpUrl = (u: string | undefined): string | null => {
  try {
    const x = new URL(u ?? "");
    return x.protocol === "https:" || x.protocol === "http:" ? x.toString() : null;
  } catch {
    return null;
  }
};

export function aktaFacts(domain: string, raw: unknown): EnrichResult["facts"] {
  const d = ((raw as { data?: Akta })?.data ?? raw ?? {}) as Akta;
  const site = httpUrl(d.firmographic?.website) ?? `https://${domain}/`;
  const facts: EnrichResult["facts"] = [];
  const add = (key: string, value: unknown, src?: string[]) => {
    const v = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
    if (v) facts.push({ key, value: v.slice(0, 1000), sourceUrl: httpUrl(src?.[0]) ?? site });
  };
  const f = d.firmographic;
  add("description", f?.company_description_short);
  add("founded_year", f?.founded_year);
  add("headcount", f?.headcount_range);
  add("company_type", f?.company_type?.label);
  add("ownership", f?.ownership_category?.label);
  add("status", f?.operating_status?.label);
  for (const s of (d.customer_profile?.segment ?? []).slice(0, 5))
    add(s.is_primary ? "customer_segment_primary" : "customer_segment", s.title, s.source);
  for (const p of (d.management_profile?.profiles ?? []).slice(0, 5))
    if (p.name && p.designation) add("leader", `${p.name}, ${p.designation}`, p.source);
  return facts;
}

export function createMonidEnrich(monid: MonidClient): EnrichFn {
  return async (domain) => {
    const { data, costUsd } = await monid.run(ENRICH_ENDPOINT, {
      queryParams: { company: `https://${domain}`, sections: [...ENRICH_SECTIONS] },
    });
    return { facts: aktaFacts(domain, data), contacts: [], costUsd };
  };
}
