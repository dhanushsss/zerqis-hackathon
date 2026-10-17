import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { config } from './config.js';
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
});
