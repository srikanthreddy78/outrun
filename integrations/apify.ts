import { timingSafeEqual } from 'node:crypto';
import { normalizeDomain } from '../src/scan/scan.ts';

export const AUDIT_MAX_PAGES = 50;
export type CrawlPage = { url: string; title?: string; text?: string; markdown?: string };
export class ApifyClient {
  private token: string; private fetcher: typeof fetch;
  constructor(token: string, fetcher: typeof fetch = fetch) { this.token = token; this.fetcher = fetcher; }
  private async api(path: string, init?: RequestInit): Promise<unknown> {
    const response = await this.fetcher(`https://api.apify.com/v2/${path}`, { ...init, headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json', ...init?.headers } });
    if (!response.ok) throw new Error(`Apify HTTP ${response.status}`);
    return response.json();
  }
  async runActor(domainInput: string): Promise<{ runId: string }> {
    const domain = normalizeDomain(domainInput);
    const result = await this.api('acts/apify~website-content-crawler/runs?maxItems=50', {
      method: 'POST', body: JSON.stringify({ startUrls: [{ url: `https://${domain}/` }], maxCrawlPages: AUDIT_MAX_PAGES, maxCrawlDepth: 3, useSitemaps: false }),
    }) as { data?: { id?: string } };
    if (!result.data?.id) throw new Error('Apify run ID missing');
    return { runId: result.data.id };
  }
  async getDataset(runId: string): Promise<CrawlPage[]> {
    if (!/^[A-Za-z0-9]+$/.test(runId)) throw new Error('Invalid run ID');
    const result = await this.api(`actor-runs/${runId}/dataset/items?limit=${AUDIT_MAX_PAGES}`);
    if (!Array.isArray(result)) throw new Error('Invalid dataset');
    return result.slice(0, AUDIT_MAX_PAGES).filter(item => item && typeof item.url === 'string').map(item => ({ url: item.url, title: item.title, text: item.text, markdown: item.markdown }));
  }
}
export function verifyApifyWebhookHeader(header: string | undefined, secret: string): boolean {
  if (!header || !secret) return false;
  const received = Buffer.from(header); const expected = Buffer.from(secret);
  return received.length === expected.length && timingSafeEqual(received, expected);
}
