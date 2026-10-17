import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshInvestigation } from './pipeline/investigate.js';
import { buildApp } from './app.js';
import { config, loadConfig, trustProxySetting } from './config.js';
import { openDatabase } from './db/database.js';
import { Store } from './db/store.js';
import { GitHubClient } from './integrations/github.js';
import { TokenFactoryClient } from './llm/client.js';
import { InvestigationQueue } from './pipeline/queue.js';

const SECRET = 'whsec_test';
let app: Awaited<ReturnType<typeof buildApp>>;
let store: Store;
const prevSecret = config.github.webhookSecret;

beforeAll(async () => {
  config.github.webhookSecret = SECRET;
  store = new Store(openDatabase(':memory:'));
  const llm = new TokenFactoryClient({ ...config.nebius, apiKey: undefined });
  const github = new GitHubClient(undefined);
  app = await buildApp({ store, llm, github, queue: new InvestigationQueue({ store, llm, github }), publicDemo: false });
});
afterAll(async () => {
  config.github.webhookSecret = prevSecret;
  await app.close();
});

function sign(body: string) {
  return `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
}

describe('webhooks', () => {
  const payload = JSON.stringify({ action: 'completed', repository: { full_name: 'acme/api', html_url: 'https://github.com/acme/api' }, workflow_run: { id: 42, conclusion: 'failure' } });

  it('rejects unsigned or wrongly signed deliveries', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/webhooks/github', payload, headers: { 'content-type': 'application/json', 'x-github-event': 'workflow_run', 'x-github-delivery': 'd-bad', 'x-hub-signature-256': 'sha256=deadbeef' } });
    expect(res.statusCode).toBe(401);
    expect(store.listDeliveries()).toHaveLength(0);
  });

  it('records a failed run once and ignores duplicate deliveries', async () => {
    const headers = { 'content-type': 'application/json', 'x-github-event': 'workflow_run', 'x-github-delivery': 'd-1', 'x-hub-signature-256': sign(payload) };
    const first = await app.inject({ method: 'POST', url: '/api/webhooks/github', payload, headers });
    expect(first.statusCode).toBe(202);
    const again = await app.inject({ method: 'POST', url: '/api/webhooks/github', payload, headers });
    expect(again.json()).toEqual({ duplicate: true });
    expect(store.listDeliveries()).toHaveLength(1);
    expect(store.listDeliveries()[0].status).toBe('recorded');
    expect(store.listRepositories()[0].fullName).toBe('acme/api');
  });

  it('ignores successful runs and pings', async () => {
    const ok = JSON.stringify({ action: 'completed', repository: { full_name: 'acme/api' }, workflow_run: { id: 43, conclusion: 'success' } });
    const r1 = await app.inject({ method: 'POST', url: '/api/webhooks/github', payload: ok, headers: { 'content-type': 'application/json', 'x-github-event': 'workflow_run', 'x-github-delivery': 'd-2', 'x-hub-signature-256': sign(ok) } });
    expect(r1.json()).toMatchObject({ ignored: true });
    const ping = '{"zen":"hi"}';
    const r2 = await app.inject({ method: 'POST', url: '/api/webhooks/github', payload: ping, headers: { 'content-type': 'application/json', 'x-github-event': 'ping', 'x-github-delivery': 'd-3', 'x-hub-signature-256': sign(ping) } });
    expect(r2.json()).toMatchObject({ pong: true });
  });
});

describe('API errors and validation', () => {
  it('returns 404 for unknown investigations and API routes', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/investigations/inv_nope' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/nope' })).statusCode).toBe(404);
  });
  it('validates request bodies', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/investigations/github', payload: { runUrl: 'not a url' } });
    expect(r.statusCode).toBe(400);
    const r2 = await app.inject({ method: 'POST', url: '/api/investigations/github', payload: { runUrl: 'https://github.com/a/b/pull/1' } });
    expect(r2.json().error).toMatch(/GitHub Actions run URL/);
    const r3 = await app.inject({ method: 'POST', url: '/api/investigations/demo', payload: { scenarioId: 'does-not-exist' } });
    expect(r3.statusCode).toBe(404);
  });
  it('requires GitHub configuration for run investigations', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/investigations/github', payload: { runUrl: 'https://github.com/a/b/actions/runs/1' } });
    expect(r.statusCode).toBe(412);
    expect(r.json().hint).toMatch(/GITHUB_TOKEN/);
  });
  it('reports integration status without exposing secrets', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/status' });
    expect(r.statusCode).toBe(200);
    expect(r.json().nebius.configured).toBe(false);
    expect(r.body).not.toMatch(/apiKey|tvly-|ghp_/);
  });
  it('saves valid settings and rejects invalid ones', async () => {
    expect((await app.inject({ method: 'PUT', url: '/api/settings', payload: { repeatDefault: 12 } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/settings' })).json().repeatDefault).toBe(12);
    expect((await app.inject({ method: 'PUT', url: '/api/settings', payload: { repeatDefault: 1000 } })).statusCode).toBe(400);
  });
  it('limits provider connection tests per client', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await app.inject({ method: 'POST', url: '/api/integrations/nebius/test', payload: {}, remoteAddress: '192.0.2.50' })).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 412)).toBe(true);
    expect(codes[10]).toBe(429);
  });
  it('lists the three demo scenarios', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/scenarios' });
    expect(r.json().map((s: { id: string }) => s.id)).toEqual(['flaky-jest', 'maven-dependency', 'code-regression']);
  });
});

describe('public demo mode', () => {
  it('blocks destructive and outward-facing actions', async () => {
    const llm = new TokenFactoryClient({ ...config.nebius, apiKey: undefined });
    const github = new GitHubClient('t');
    const s = new Store(openDatabase(':memory:'));
    const pub = await buildApp({ store: s, llm, github, queue: new InvestigationQueue({ store: s, llm, github }), publicDemo: true });
    expect((await pub.inject({ method: 'PUT', url: '/api/settings', payload: { repeatDefault: 5 } })).statusCode).toBe(403);
    expect((await pub.inject({ method: 'POST', url: '/api/investigations/github', payload: { runUrl: 'https://github.com/a/b/actions/runs/1' } })).statusCode).toBe(403);
    await pub.close();
  });

  it('regression (QA F8 probe): provider connection tests are refused without any provider call', async () => {
    const calls: string[] = [];
    const spy = (async (url: string) => {
      calls.push(String(url));
      throw new Error('must not be called');
    }) as unknown as typeof fetch;
    const llm = new TokenFactoryClient({ ...config.nebius, apiKey: 'test-key-not-real', baseUrl: 'http://127.0.0.1:9/v1' }, spy);
    const s = new Store(openDatabase(':memory:'));
    const github = new GitHubClient(undefined);
    const pub = await buildApp({ store: s, llm, github, queue: new InvestigationQueue({ store: s, llm, github }), publicDemo: true });
    for (const url of ['/api/integrations/nebius/test', '/api/integrations/tavily/test']) {
      const r = await pub.inject({ method: 'POST', url, payload: {} });
      expect(r.statusCode).toBe(403);
    }
    expect(calls).toEqual([]);
    await pub.close();
  });
});

describe('public demo backpressure', () => {
  it('regression (acceptance 2026-10-17): re-runs and re-validations are refused while the demo queue is full', async () => {
    const llm = new TokenFactoryClient({ ...config.nebius, apiKey: undefined });
    const github = new GitHubClient(undefined);
    const s = new Store(openDatabase(':memory:'));
    const full = { depth: 4, position: () => -1, enqueue: () => { throw new Error('must not enqueue'); } } as unknown as InvestigationQueue;
    const pub = await buildApp({ store: s, llm, github, queue: full, publicDemo: true });
    const inv = s.createInvestigation(freshInvestigation({ source: 'demo', scenarioId: 'code-regression', repository: 'alibi-demo/pricing-engine', commitSha: 'a'.repeat(40), status: 'completed' }));
    s.addPatch({ id: 'patch_bp', investigationId: inv.id, origin: 'deterministic', strategy: 'code_patch', title: 't', rationale: '', diff: '', files: [], status: 'validated', validation: null, prUrl: null, prBranch: null, createdAt: inv.createdAt });
    const rerun = await pub.inject({ method: 'POST', url: `/api/investigations/${inv.id}/rerun`, payload: {} });
    expect(rerun.statusCode).toBe(503);
    const validate = await pub.inject({ method: 'POST', url: '/api/patches/patch_bp/validate', payload: {} });
    expect(validate.statusCode).toBe(503);
    expect(s.getPatch('patch_bp')!.status).toBe('validated');
    expect(s.listInvestigations({})).toHaveLength(1);
    await pub.close();
  });
});

describe('client identity for rate limits', () => {
  const build = async (trustProxy: false | string) => {
    const llm = new TokenFactoryClient({ ...config.nebius, apiKey: undefined });
    const github = new GitHubClient(undefined);
    const s = new Store(openDatabase(':memory:'));
    return buildApp({ store: s, llm, github, queue: new InvestigationQueue({ store: s, llm, github }), publicDemo: true, trustProxy });
  };
  // Starts are counted before the body is validated, so an unknown scenario exercises the limiter without running anything.
  const start = (a: Awaited<ReturnType<typeof build>>, headers: Record<string, string> = {}, remoteAddress = '127.0.0.1') =>
    a.inject({ method: 'POST', url: '/api/investigations/demo', payload: { scenarioId: 'does-not-exist' }, headers, remoteAddress });

  it('regression (QA F8): a client cannot reset its per-IP limit with a spoofed X-Forwarded-For', async () => {
    const a = await build(false);
    for (let i = 0; i < 6; i++) expect((await start(a)).statusCode).toBe(404);
    expect((await start(a)).statusCode).toBe(429);
    expect((await start(a, { 'x-forwarded-for': '203.0.113.77' })).statusCode).toBe(429);
    await a.close();
  });

  it('behind an explicitly trusted proxy, the proxy-appended client address is used and spoofed entries are ignored', async () => {
    const a = await build('127.0.0.1');
    // The proxy (127.0.0.1) appends the real client 198.51.100.1 after whatever the client sent.
    for (let i = 0; i < 6; i++) expect((await start(a, { 'x-forwarded-for': `203.0.113.${i}, 198.51.100.1` })).statusCode).toBe(404);
    expect((await start(a, { 'x-forwarded-for': '203.0.113.99, 198.51.100.1' })).statusCode).toBe(429);
    // A different real client behind the same proxy has its own budget.
    expect((await start(a, { 'x-forwarded-for': '198.51.100.2' })).statusCode).toBe(404);
    // An untrusted peer cannot use the header at all.
    expect((await start(a, { 'x-forwarded-for': '198.51.100.3' }, '192.0.2.10')).statusCode).toBe(404);
    for (let i = 0; i < 5; i++) await start(a, { 'x-forwarded-for': `198.51.100.${10 + i}` }, '192.0.2.10');
    expect((await start(a, { 'x-forwarded-for': '198.51.100.99' }, '192.0.2.10')).statusCode).toBe(429);
    await a.close();
  });

  it('parses ALIBI_TRUST_PROXY conservatively', () => {
    expect(trustProxySetting(undefined)).toBe(false);
    expect(trustProxySetting('false')).toBe(false);
    expect(trustProxySetting('true')).toBe(false);
    expect(trustProxySetting('1')).toBe(1);
    expect(trustProxySetting('127.0.0.1, 10.0.0.0/8')).toBe('127.0.0.1,10.0.0.0/8');
    expect(trustProxySetting('127.0.0.1,evil host')).toBe('127.0.0.1');
  });
});

describe('agent-loop configuration limits', () => {
  const load = (env: Record<string, string>) => {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    try {
      return loadConfig().agentLoop;
    } finally {
      process.env = saved;
    }
  };
  it('regression (QA C7 probe): negative or non-numeric limits fall back to defaults; caps cannot be raised', () => {
    const neg = load({ ALIBI_LOOP_MAX_RUNS: '-5', ALIBI_LOOP_MAX_TOKENS: '-1', ALIBI_LOOP_MAX_MS: '1e9', ALIBI_LOOP_MAX_ITERATIONS: '2.5' });
    expect([neg.maxRuns, neg.maxTokens, neg.maxMs, neg.maxIterations]).toEqual([30, 40_000, 480_000, 4]);
    const high = load({ ALIBI_LOOP_MAX_RUNS: '100000', ALIBI_LOOP_MAX_TOKENS: '99999999', ALIBI_LOOP_MAX_MS: '999999999', ALIBI_LOOP_MAX_ITERATIONS: '9', ALIBI_LOOP_MAX_RUNS_PER_ACTION: '99' });
    expect([high.maxRuns, high.maxTokens, high.maxMs, high.maxIterations, high.maxRunsPerAction]).toEqual([200, 500_000, 3_600_000, 4, 20]);
    expect(load({ ALIBI_LOOP_MAX_RUNS: '0' }).maxRuns).toBe(0);
    expect(load({ ALIBI_LOOP: 'yes' }).enabled).toBe(false);
  });
});
