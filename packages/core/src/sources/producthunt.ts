/**
 * Product Hunt's public Atom feed of today's launches. The feed links to a /r/p/<id> redirect, so
 * the product's own domain is where that redirect lands (followed with safeFetch, a few per run).
 */
import type { DiscoveredCompany } from "../integrations/types";
import { clean, dedupe, registrableDomain, type SourceFetch } from "./common";

export const PRODUCT_HUNT_FEED = "https://www.producthunt.com/feed";
const MAX_RESOLVE = 15;

const decode = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

export interface FeedEntry {
  ref: string;
  name: string;
  summary: string;
  redirect: string | null;
}

export function parseProductHuntFeed(xml: string): FeedEntry[] {
  const out: FeedEntry[] = [];
  for (const block of xml.split("<entry>").slice(1)) {
    const id = /<id>[^<]*Post\/(\d+)<\/id>/.exec(block)?.[1];
    const name = /<title>([^<]*)<\/title>/.exec(block)?.[1];
    if (!id || !name) continue;
    const html = decode(/<content[^>]*>([\s\S]*?)<\/content>/.exec(block)?.[1] ?? "");
    const summary = clean(/<p>([\s\S]*?)<\/p>/.exec(html)?.[1]?.replace(/<[^>]+>/g, ""));
    const redirect = /href="(https:\/\/www\.producthunt\.com\/r\/p\/\d+[^"]*)"/.exec(html)?.[1] ?? null;
    out.push({ ref: `ph:${id}`, name: clean(decode(name), 120), summary, redirect });
  }
  return out;
}

export async function fetchProductHunt(get: SourceFetch, limit: number): Promise<DiscoveredCompany[]> {
  const res = await get(PRODUCT_HUNT_FEED);
  if (res.status !== 200) throw new Error(`product hunt: HTTP ${res.status}`);
  const out: DiscoveredCompany[] = [];
  for (const e of parseProductHuntFeed(res.body).slice(0, Math.min(limit, MAX_RESOLVE))) {
    if (!e.redirect) continue;
    try {
      const landed = await get(e.redirect);
      const domain = registrableDomain(landed.url);
      if (domain)
        out.push({ domain, name: e.name, source: "producthunt", sourceRef: e.ref, summary: e.summary });
    } catch {
      // One product's site being down doesn't stop the run.
    }
  }
  return dedupe(out);
}
