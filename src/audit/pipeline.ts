import { randomBytes } from 'node:crypto';
import type { Check } from '../scan/contracts.ts';
import { PRODUCTS } from '../scan/contracts.ts';

export type Offer = 'auditKit' | 'growth';
export type Finding = { id: string; title: string; detail: string; evidence: { sourceUrl?: string; checkId?: string } };
export type Audit = { orderId: string; domain: string; findings: Finding[]; crawlRunId: string };
export type KitAsset = { name: string; content: string; mediaType: string };
export type Report = { orderId: string; domain: string; offer: Offer; token: string; audit: Audit; assets: KitAsset[]; totalCostUsd: number; deliveredAt?: string };
export interface KitDependencies {
  llm: (input: { asset: string; audit: Audit }) => Promise<{ content: string; costUsd: number }>;
  discover: (domain: string, limit: number) => Promise<Array<{ company: string; domain: string }>>;
  deliver: (report: Report) => Promise<void>;
}
const ASSETS = ['llms.txt', 'server.json', 'listing-copy.md', 'openapi-fixes.md', 'quickstart.md', 'positioning-and-icp.md', 'email-sequence.md', '30-day-plan.md'] as const;
export function validateFindings(findings: Finding[], checks: Check[]): void {
  const known = new Set(checks.map(check => check.id));
  for (const finding of findings) {
    const sourceUrl = finding.evidence?.sourceUrl;
    if (!sourceUrl && !finding.evidence?.checkId) throw new Error(`Finding ${finding.id} has no evidence`);
    if (finding.evidence?.checkId && !known.has(finding.evidence.checkId)) throw new Error(`Finding ${finding.id} has unknown check ID`);
    if (sourceUrl && !/^https?:\/\//.test(sourceUrl)) throw new Error(`Finding ${finding.id} has invalid source URL`);
  }
}
function validateAsset(name: string, content: string, findings: Finding[]): void {
  if (!content.trim()) throw new Error(`Empty ${name}`);
  if (name === 'llms.txt' && !/^#\s+\S/m.test(content)) throw new Error('Invalid llms.txt');
  if (name === 'server.json') { const value = JSON.parse(content); if (typeof value.name !== 'string' || !value.name || typeof value.url !== 'string' || !/^https:\/\//.test(value.url)) throw new Error('Invalid server.json'); }
  if (name !== 'server.json' && findings.length) {
    const citations = new Set(findings.map(finding => `[${finding.id}]`));
    for (const line of content.split('\n').map(value => value.trim()).filter(value => value && !value.startsWith('#') && !value.startsWith('```'))) {
      if (![...citations].some(citation => line.includes(citation))) throw new Error(`${name} has an uncited claim`);
    }
  }
}
export class AuditPipeline {
  private reports = new Map<string, Report>(); private seenRuns = new Set<string>();
  private inFlight = new Map<string, Promise<Report>>();
  private deps: KitDependencies;
  constructor(deps: KitDependencies) { this.deps = deps; }
  acceptCrawlWebhook(runId: string): boolean { if (this.seenRuns.has(runId)) return false; this.seenRuns.add(runId); return true; }
  buildAndDeliver(input: { orderId: string; domain: string; offer: Offer; findings: Finding[]; checks: Check[]; crawlRunId: string; crawlCostUsd: number }): Promise<Report> {
    const running = this.inFlight.get(input.orderId); if (running) return running;
    const work = this.build(input).finally(() => this.inFlight.delete(input.orderId));
    this.inFlight.set(input.orderId, work); return work;
  }
  private async build(input: { orderId: string; domain: string; offer: Offer; findings: Finding[]; checks: Check[]; crawlRunId: string; crawlCostUsd: number }): Promise<Report> {
    const previous = this.reports.get(input.orderId);
    if (previous) { if (!previous.deliveredAt) { await this.deps.deliver(previous); previous.deliveredAt = new Date().toISOString(); } return previous; }
    validateFindings(input.findings, input.checks);
    const audit: Audit = { orderId: input.orderId, domain: input.domain, findings: input.findings, crawlRunId: input.crawlRunId };
    const assets: KitAsset[] = []; let totalCostUsd = input.crawlCostUsd;
    for (const name of ASSETS) {
      const response = await this.deps.llm({ asset: name, audit }); validateAsset(name, response.content, input.findings);
      totalCostUsd += response.costUsd; assets.push({ name, content: response.content, mediaType: name.endsWith('.json') ? 'application/json' : 'text/markdown' });
    }
    const prospects = await this.deps.discover(input.domain, 50);
    if (prospects.length !== 50 || prospects.some(item => !item.company || !item.domain)) throw new Error('Kit requires 50 sourced prospects');
    assets.push({ name: 'prospects.json', content: JSON.stringify(prospects), mediaType: 'application/json' });
    const report: Report = { orderId: input.orderId, domain: input.domain, offer: input.offer, token: randomBytes(32).toString('base64url'), audit, assets, totalCostUsd };
    this.reports.set(input.orderId, report);
    await this.deps.deliver(report); report.deliveredAt = new Date().toISOString();
    return report;
  }
  getByToken(token: string): Report | undefined { return [...this.reports.values()].find(report => report.token === token && report.deliveredAt); }
}
export function downloadAsset(report: Report, name: string): { status: number; headers: Record<string, string>; body: string } {
  const asset = report.assets.find(item => item.name === name);
  if (!asset) return { status: 404, headers: { 'cache-control': 'no-store' }, body: '' };
  return { status: 200, headers: { 'content-type': asset.mediaType, 'content-disposition': `attachment; filename="${asset.name}"`, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' }, body: asset.content };
}
export function renderReportPage(report: Report): string {
  const esc = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>Audit for ${esc(report.domain)}</title></head><body><main><h1>${esc(report.domain)} audit</h1><p>${esc(PRODUCTS[report.offer].name)}</p><h2>Findings</h2><ol>${report.audit.findings.map(finding => `<li><strong>${esc(finding.title)}</strong> — ${esc(finding.detail)}</li>`).join('')}</ol><h2>Kit assets</h2><ul>${report.assets.map(asset => `<li><a href="/report/${encodeURIComponent(report.token)}/asset/${encodeURIComponent(asset.name)}">${esc(asset.name)}</a></li>`).join('')}</ul></main></body></html>`;
}
