/**
 * The signal scout's search: one Monid run of context.dev's company news search, by domain,
 * SIGNAL_SEARCH_LIMIT articles (~$0.002). Articles are outside text: the tool wraps them as
 * untrusted. Only http(s) links are kept.
 */
import { SIGNAL_SEARCH_ENDPOINT, SIGNAL_SEARCH_LIMIT } from "../constants";
import type { MonidClient } from "./types";

export interface SignalItem {
  title: string;
  summary: string;
  url: string;
  /** YYYY-MM-DD, or null when the article has no date. */
  date: string | null;
}

type Article = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const httpUrl = (u: string): string | null => {
  try {
    const x = new URL(u);
    return x.protocol === "https:" || x.protocol === "http:" ? x.toString() : null;
  } catch {
    return null;
  }
};
const dayOf = (v: string): string | null => {
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
};

/** The articles in a news search response, whichever envelope it comes in. */
export function parseSignalSearch(raw: unknown, limit = SIGNAL_SEARCH_LIMIT): SignalItem[] {
  const r = (raw ?? {}) as Record<string, unknown>;
  const inner = (r.data && !Array.isArray(r.data) ? r.data : r) as Record<string, unknown>;
  const list = [inner.articles, inner.results, inner.data, r.data, raw].find(Array.isArray) as
    Article[] | undefined;
  const out: SignalItem[] = [];
  for (const a of list ?? []) {
    const url = httpUrl(str(a.url) || str(a.link));
    const title = str(a.headline) || str(a.title);
    if (!url || !title) continue;
    out.push({
      title: title.slice(0, 300),
      summary: (str(a.description) || str(a.summary) || str(a.snippet)).slice(0, 1000),
      url,
      date: dayOf(str(a.published_at) || str(a.publishedAt) || str(a.date)),
    });
    if (out.length >= limit) break;
  }
  return out;
}

export async function searchSignals(
  monid: Pick<MonidClient, "run">,
  domain: string,
): Promise<{ items: SignalItem[]; costUsd: number }> {
  const { data, costUsd } = await monid.run(SIGNAL_SEARCH_ENDPOINT, {
    searchBy: { type: "entity", entity: { type: "domain", domain } },
    limit: SIGNAL_SEARCH_LIMIT,
  });
  return { items: parseSignalSearch(data), costUsd };
}
