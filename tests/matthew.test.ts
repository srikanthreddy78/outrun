import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { safeFetch, isPublicIp, UnsafeUrlError, ResponseLimitError } from '../src/safeFetch.ts';
import { quickScan, fullScan, bodyText } from '../src/scan/scan.ts';
import { MemoryScanStore, RateLimitError, ScanService } from '../src/scan/service.ts';
import { renderLandingPage, renderScorePage, scoreApi } from '../src/scan/http.ts';
import { ACCESS_TERMS_VERSION, PaidAccessManager } from '../src/audit/access.ts';
import { AuditPipeline, downloadAsset, renderReportPage } from '../src/audit/pipeline.ts';
import { ApifyClient, verifyApifyWebhookHeader } from '../integrations/apify.ts';
import { isAllowedTeamAccount, renderDashboard, summarizeLedger } from '../src/dashboard/views.ts';

const homepage = '<html><body><h1>Automate your customer support with agents</h1><p>Our platform helps teams answer questions and launch reliable workflows every day.</p><a href="/signup">Get started</a><a href="/contact">Contact</a><p>Trusted by customers</p><script type="application/ld+json">{"price":499}</script><script>gtag()</script></body></html>';
const fixture = async (url: string) => {
  const path = new URL(url).pathname;
  const response = ({ status, body, headers = {} }: { status: number; body: string; headers?: Record<string, string> }) => ({ url, status, body, headers });
  if (path === '/') return response({ status: 200, body: homepage });
  if (path === '/llms.txt') return response({ status: 200, body: '# Product\nUseful details' });
  if (path === '/sitemap.xml') return response({ status: 200, body: '<urlset></urlset>' });
  if (path === '/robots.txt') return response({ status: 200, body: 'User-agent: GPTBot\nAllow: /' });
  if (path === '/openapi.json') return response({ status: 200, body: '{"openapi":"3.1.0"}' });
  if (path === '/.well-known/agent.json') return response({ status: 200, body: '{}' });
  if (path === '/docs') return response({ status: 200, body: '<html><body>These are the documentation pages for developers.</body></html>' });
  if (path === '/mcp') return response({ status: 200, body: '{}', headers: { 'content-type': 'application/json' } });
  if (path === '/signup') return response({ status: 200, body: '<form method="post"><input></form>' });
  return response({ status: 404, body: 'missing' });
};

test('safe fetch blocks private IPs, DNS rebinding and private redirects', async () => {
  for (const address of ['127.0.0.1', '10.1.1.1', '169.254.169.254', '192.168.1.1', '::1', 'fc00::1']) assert.equal(isPublicIp(address), false);
  assert.equal(isPublicIp('8.8.8.8'), true);
  await assert.rejects(safeFetch('http://example.com', { resolver: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }], transport: async () => { throw new Error('must not connect'); } }), UnsafeUrlError);
  const seen: string[] = [];
  await assert.rejects(safeFetch('https://example.com', {
    resolver: async host => [{ address: host === 'example.com' ? '8.8.8.8' : '10.0.0.1', family: 4 }],
    transport: async (url, ip) => { seen.push(ip); return { url: url.toString(), status: 302, headers: { location: 'https://private.example/path' }, body: '' }; },
  }), UnsafeUrlError);
  assert.deepEqual(seen, ['8.8.8.8']);
  await assert.rejects(safeFetch('https://example.com', { resolver: async () => [{ address: '8.8.8.8', family: 4 }], maxBytes: 5, transport: async url => ({ url: url.toString(), status: 200, headers: {}, body: 'long response' }) }), ResponseLimitError);
  await assert.rejects(safeFetch('https://example.com', { resolver: async () => [{ address: '8.8.8.8', family: 4 }], maxRedirects: 1, transport: async url => ({ url: url.toString(), status: 302, headers: { location: '/again' }, body: '' }) }), UnsafeUrlError);
  await assert.rejects(safeFetch('https://example.com', { timeoutMs: 2, resolver: async () => new Promise(() => {}), transport: async () => { throw new Error('must not connect'); } }));
});

test('staged scan reports evidence, unknown checks, safe signup wall and supplied metrics', async () => {
  const partial = await quickScan('example.com', fixture);
  assert.equal(partial.state, 'partial'); assert.equal(partial.checks.length, 5);
  const full = await fullScan(partial, fixture, { suppliedBy: 'business-agent', metrics: { startDate: '2026-10-01', endDate: '2026-10-31', visits: 1000, leads: 100, customers: 10, revenueUsd: 1000, spendUsd: 250 } });
  assert.equal(full.state, 'complete'); assert.equal(full.checks.length, 19);
  assert.equal(full.checks.find(check => check.id === 'rate-limit')?.status, 'unknown');
  assert.equal(full.journey?.outcome, 'signup-wall');
  assert.equal(full.scores.marketingEffectiveness?.visitToLead, .1);
  assert.equal(full.scores.marketingEffectiveness?.returnOnAdSpend, 4);
  assert.ok(full.checks.every(check => check.evidence));
  assert.match(renderScorePage(full), /Site readiness/); assert.match(renderScorePage(full), /Growth Department/);
});

test('public cache excludes private metrics and rate limit returns 429', async () => {
  const store = new MemoryScanStore(); const service = new ScanService(store, fixture, 'test-salt');
  const first = await service.request('example.com', '203.0.113.1', { suppliedBy: 'business-agent', campaignUrls: ['https://example.com/offer?utm_source=agent&utm_campaign=fall'], metrics: { startDate: '2026-10-01', endDate: '2026-10-31', visits: 10, leads: 2 } });
  assert.ok(first.scores.marketingEffectiveness); assert.equal(store.scans.get('example.com')?.scores.marketingEffectiveness, undefined);
  assert.equal(first.checks.find(check => check.id === 'campaign-tracking')?.status, 'pass');
  assert.equal(store.scans.get('example.com')?.checks.some(check => check.id === 'campaign-tracking'), false);
  assert.deepEqual([...store.queue], ['example.com']);
  const complete = await service.complete('example.com'); assert.equal(complete.state, 'complete');
  assert.equal((await service.request('example.com', '203.0.113.1')).scores.marketingEffectiveness, undefined);
  for (let i = 0; i < 18; i++) await service.request('example.com', '203.0.113.1');
  await assert.rejects(service.request('example.com', '203.0.113.1'), RateLimitError);
  assert.equal((await scoreApi(service, 'example.com', '203.0.113.1')).status, 429);
  assert.match(renderLandingPage(), /\$1,500|\$1500/);
});

test('credential use requires domain proof, current terms and remains revocable', async () => {
  const vault = { put: async (_orderId: string, value: { username: string; password: string }) => { assert.equal(value.password, 'secret'); return 'vault:1'; } };
  const access = new PaidAccessManager(vault);
  const challenge = access.issueChallenge('order-1', 'example.com');
  await assert.rejects(access.submitCredential('order-1', { username: 'test', password: 'secret' }));
  await access.verifyDomain('order-1', async name => { assert.equal(name, '_aga-verify.example.com'); return [challenge.token]; });
  assert.throws(() => access.acceptTerms('order-1', { authorityAttested: false, termsVersion: ACCESS_TERMS_VERSION }));
  access.acceptTerms('order-1', { authorityAttested: true, termsVersion: ACCESS_TERMS_VERSION });
  await access.submitCredential('order-1', { username: 'test', password: 'secret' });
  assert.equal(access.assertCanUseCredential('order-1'), 'vault:1');
  assert.equal(JSON.stringify(access.snapshot('order-1')).includes('vault:1'), false);
  access.revoke('order-1'); assert.throws(() => access.assertCanUseCredential('order-1'));
});

test('both offers receive the same kit, delivery and cost; webhook dedupes', async () => {
  const delivered: string[] = [];
  const pipeline = new AuditPipeline({
    llm: async ({ asset }) => ({ content: asset === 'server.json' ? '{"name":"Example","url":"https://example.com/mcp"}' : asset === 'llms.txt' ? '# Example\nProduct information [f1]' : `# ${asset}\nFix finding [f1]`, costUsd: .1 }),
    discover: async (_domain, limit) => Array.from({ length: limit }, (_, i) => ({ company: `Company ${i}`, domain: `company${i}.com` })),
    deliver: async report => { delivered.push(report.orderId); },
  });
  assert.equal(pipeline.acceptCrawlWebhook('run-1'), true); assert.equal(pipeline.acceptCrawlWebhook('run-1'), false);
  const input = { domain: 'example.com', findings: [{ id: 'f1', title: 'Improve docs', detail: 'Add API examples', evidence: { checkId: 'docs' } }], checks: [{ id: 'docs', category: 'readiness' as const, tier: 'full' as const, label: 'Docs', status: 'fail' as const, evidence: '404', weight: 10 }], crawlRunId: 'run-1', crawlCostUsd: .5 };
  const audit = await pipeline.buildAndDeliver({ ...input, orderId: 'a', offer: 'auditKit' });
  const growth = await pipeline.buildAndDeliver({ ...input, orderId: 'b', offer: 'growth' });
  assert.deepEqual(audit.assets.map(asset => asset.name), growth.assets.map(asset => asset.name));
  assert.equal(audit.totalCostUsd, 1.3); assert.deepEqual(delivered, ['a', 'b']);
  assert.equal((await pipeline.buildAndDeliver({ ...input, orderId: 'a', offer: 'auditKit' })).token, audit.token);
  assert.match(renderReportPage(audit), /noindex,nofollow/);
  assert.equal(pipeline.getByToken(audit.token)?.orderId, 'a');
  assert.equal(downloadAsset(audit, 'llms.txt').status, 200);
  assert.equal(downloadAsset(audit, 'missing').status, 404);
});

test('a failed delivery retries without rebuilding the Kit', async () => {
  let calls = 0; let sends = 0;
  const pipeline = new AuditPipeline({
    llm: async ({ asset }) => { calls++; return { content: asset === 'server.json' ? '{"name":"Example","url":"https://example.com/mcp"}' : asset === 'llms.txt' ? '# Example\nFinding [f1]' : '# Asset\nFinding [f1]', costUsd: 0 }; },
    discover: async (_domain, limit) => Array.from({ length: limit }, (_, i) => ({ company: `Company ${i}`, domain: `company${i}.com` })),
    deliver: async () => { sends++; if (sends === 1) throw new Error('mail failed'); },
  });
  const input = { orderId: 'retry', domain: 'example.com', offer: 'auditKit' as const, findings: [{ id: 'f1', title: 'Docs', detail: 'Fix docs', evidence: { sourceUrl: 'https://example.com/docs' } }], checks: [], crawlRunId: 'run1', crawlCostUsd: 0 };
  await assert.rejects(pipeline.buildAndDeliver(input));
  const report = await pipeline.buildAndDeliver(input);
  assert.equal(report.deliveredAt !== undefined, true); assert.equal(calls, 8); assert.equal(sends, 2);
});

test('Apify adapter caps public crawl and authenticates webhook header', async () => {
  const requests: Array<{ url: string; body?: string }> = [];
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), body: init?.body?.toString() });
    return new Response(JSON.stringify(requests.length === 1 ? { data: { id: 'run123' } } : [{ url: 'https://example.com/' }]), { status: 200 });
  };
  const client = new ApifyClient('token', fakeFetch as typeof fetch);
  assert.equal((await client.runActor('example.com')).runId, 'run123');
  assert.equal(JSON.parse(requests[0].body!).maxCrawlPages, 50);
  assert.equal((await client.getDataset('run123')).length, 1);
  assert.equal(verifyApifyWebhookHeader('secret', 'secret'), true);
  assert.equal(verifyApifyWebhookHeader('wrong', 'secret'), false);
});

test('signed-in ledger uses event totals and shows agent stop reasons', () => {
  const input = { events: [
    { id: '1', at: '2026-11-07', type: 'candidate.discovered', actor: 'prospector', entityId: 'c1' },
    { id: '2', at: '2026-11-07', type: 'order.paid', actor: 'stripe', entityId: 'o1', payload: { amountUsd: 499 } },
    { id: '3', at: '2026-11-07', type: 'report.delivered', actor: 'worker', entityId: 'o1' },
    { id: '4', at: '2026-11-07', type: 'llm.cost', actor: 'worker', costUsd: 2 },
    { id: '5', at: '2026-11-07', type: 'apify.cost', actor: 'worker', costUsd: 1 },
  ], agents: [{ name: 'auditor', status: 'idle', stopReason: 'end_turn', spendUsd: 2, budgetUsd: 3 }], queuedJobs: 1, approvalsWaiting: 0, integrations: { apify: 'healthy' as const } };
  assert.equal(summarizeLedger(input.events).costPerDeliveredAuditUsd, 3);
  assert.equal(isAllowedTeamAccount('Team@example.com', 'team@example.com,owner@example.com'), true);
  assert.equal(isAllowedTeamAccount('outsider@example.com', 'team@example.com'), false);
  assert.equal(renderDashboard('ledger', input, false).status, 302);
  assert.match(renderDashboard('ledger', input, true).body, /\$3\.00/);
  assert.match(renderDashboard('agents', input, true).body, /end_turn/);
});

test('safe fetch makes a real pinned request without an injected transport', async () => {
  const hosts: string[] = [];
  const server = createServer((req, res) => {
    hosts.push(req.headers.host ?? '');
    if (req.url === '/slow') return; // never answers
    res.writeHead(200, { 'content-type': 'text/plain' }).end('hello from loopback');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const resolver = async () => [{ address: '127.0.0.1', family: 4 as const }];
  try {
    const response = await safeFetch('http://pinned.example/hello', { resolver, allowLoopbackForTests: { address: '127.0.0.1', port } });
    assert.equal(response.status, 200);
    assert.equal(response.body, 'hello from loopback');
    assert.match(hosts[0] ?? '', /^pinned\.example/);
    // Without the test override the same DNS answer is still refused.
    await assert.rejects(safeFetch('http://pinned.example/hello', { resolver }), UnsafeUrlError);
    // A caller-supplied signal keeps the timeout deadline.
    const started = Date.now();
    await assert.rejects(safeFetch('http://pinned.example/slow', { resolver, allowLoopbackForTests: { address: '127.0.0.1', port }, timeoutMs: 100, signal: new AbortController().signal }));
    assert.ok(Date.now() - started < 2000);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('scan regexes stay linear on a hostile 2 MB page', async () => {
  const hostile = ('<a>' + 'x'.repeat(10)).repeat(Math.ceil(2 * 1024 * 1024 / 13));
  const variants = [hostile, '<html><body>' + hostile, ('<a href="/x">xxx').repeat(160_000), ('<script>xxxxx').repeat(160_000), ('<<<<').repeat(500_000), ('<h1 ').repeat(500_000), ('<link ').repeat(350_000)];
  const source = (body: string) => async (url: string) => ({ url, status: 200, headers: {}, body });
  const started = Date.now();
  for (const body of variants) {
    const partial = await quickScan('example.com', source(body));
    await fullScan(partial, source(body));
    bodyText(body.slice(0, 256 * 1024));
  }
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
});

test('scan CTA detection keeps working on normal markup', async () => {
  const page = (cta: string) => async (url: string) => ({ url, status: 200, headers: {}, body: `<html><body><h1>A clear value proposition</h1>${cta}</body></html>` });
  const cta = async (markup: string) => (await quickScan('example.com', page(markup))).checks.find(check => check.id === 'clear-cta')?.status;
  assert.equal(await cta('<a href="/signup" class="btn"><span>Get <b>started</b></span></a>'), 'pass');
  assert.equal(await cta('<BUTTON type="button">Book demo</BUTTON>'), 'pass');
  assert.equal(await cta('<a href="/about">About us</a><p>no action</p>'), 'fail');
  assert.equal((await quickScan('example.com', page(''))).checks.find(check => check.id === 'value-proposition')?.status, 'pass');
  assert.equal(bodyText('<p>Hi<script>var a = "<b>";</script> <style>p{}</style><b>there</b></p>'), 'Hi there');
});
