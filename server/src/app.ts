import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { config, ROOT_DIR } from './config.js';
import { splitLines } from './analysis/logs.js';
import type { Store } from './db/store.js';
import { CLASSIFICATIONS, type Investigation } from './domain/types.js';
import { GitHubClient, GitHubError, parseRunUrl, verifyWebhookSignature } from './integrations/github.js';
import { tavilyConfigured, tavilySearch } from './integrations/tavily.js';
import { TokenFactoryClient } from './llm/client.js';
import { IntakeError, startDemo, startFromGitHubRun } from './pipeline/intake.js';
import { InvestigationRun } from './pipeline/investigate.js';
import { InvestigationQueue } from './pipeline/queue.js';
import { loadReplay } from './pipeline/replay.js';
import { checkDocker } from './runner/docker.js';
import { applyPatch, checkout } from './runner/workspace.js';
import { getScenario, listScenarios } from './scenarios/registry.js';

export interface AppDeps {
  store: Store;
  llm: TokenFactoryClient;
  github: GitHubClient;
  queue: InvestigationQueue;
  publicDemo?: boolean;
}

const ModeSchema = z.enum(['auto', 'live', 'replay', 'heuristic']).optional();
const RepeatSchema = z.coerce.number().int().min(2).max(30).optional();

/** Fixed-window per-IP limiter for endpoints that start work. */
function rateLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (ip: string): boolean => {
    const now = Date.now();
    const h = hits.get(ip);
    if (!h || h.reset < now) {
      hits.set(ip, { n: 1, reset: now + windowMs });
      return true;
    }
    h.n++;
    return h.n <= limit;
  };
}

function sendError(reply: FastifyReply, status: number, message: string, hint?: string) {
  return reply.status(status).send({ error: message, hint });
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { store, llm, github, queue } = deps;
  const publicDemo = deps.publicDemo ?? config.demoReadOnly;
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.authorization', 'req.headers["x-hub-signature-256"]'] },
    bodyLimit: 5 * 1024 * 1024,
    trustProxy: true,
  });
  const startLimit = rateLimiter(publicDemo ? 6 : 120, 60 * 60_000);

  // Keep the raw body for webhook signature verification.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    (req as FastifyRequest & { rawBody?: Buffer }).rawBody = body as Buffer;
    if (!(body as Buffer).length) return done(null, {});
    try {
      done(null, JSON.parse((body as Buffer).toString('utf8')));
    } catch {
      const err = new Error('Invalid JSON body') as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) return sendError(reply, 400, 'Invalid request', err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    if (err instanceof IntakeError) return sendError(reply, err.status, err.message, err.hint);
    if ((err as unknown) instanceof GitHubError) {
      const ge = err as unknown as GitHubError;
      return sendError(reply, ge.status && ge.status < 500 ? ge.status : 502, ge.message, ge.hint);
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    return sendError(reply, status, status >= 500 ? 'Internal error' : err.message);
  });

  // ------------------------------------------------------------- status
  app.get('/api/health', async () => ({ ok: true, queue: queue.depth }));

  app.get('/api/status', async () => {
    const docker = await checkDocker();
    let models: unknown = null;
    if (llm.configured) {
      try {
        const m = await llm.listModels();
        models = { triage: m.triage, reasoning: m.reasoning, deep: m.deep, nemotronAvailable: m.available.filter((x) => /nemotron/i.test(x)), notes: m.notes };
      } catch (err) {
        models = { error: (err as Error).message };
      }
    }
    return {
      publicDemo,
      nebius: { configured: llm.configured, baseUrl: llm.baseUrl, models },
      tavily: { configured: tavilyConfigured() },
      github: { configured: github.configured, webhookSecret: Boolean(config.github.webhookSecret), autoInvestigate: autoInvestigate() },
      runner: { backend: config.runner.backend, ...docker, nodeImage: config.runner.nodeImage, mavenImage: config.runner.mavenImage, cpus: config.runner.cpus, memory: config.runner.memory },
      replays: Object.fromEntries(listScenarios().map((s) => [s.id, loadReplay(s.id)?.recordedAt ?? null])),
      queue: queue.depth,
    };
  });

  app.get('/api/overview', async () => {
    const all = store.listInvestigations({ limit: 500 });
    const byClass: Record<string, number> = {};
    const byVerdict: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    let experiments = 0;
    let executedRuns = 0;
    let validatedFixes = 0;
    let patchesTotal = 0;
    const bySource: Record<string, number> = {};
    for (const inv of all) {
      if (inv.classification) byClass[inv.classification] = (byClass[inv.classification] ?? 0) + 1;
      if (inv.verdict) byVerdict[inv.verdict] = (byVerdict[inv.verdict] ?? 0) + 1;
      byStatus[inv.status] = (byStatus[inv.status] ?? 0) + 1;
      bySource[inv.source] = (bySource[inv.source] ?? 0) + 1;
    }
    for (const inv of all.slice(0, 200)) {
      for (const e of store.listExperiments(inv.id)) {
        if (e.backend === 'docker' && e.result) {
          experiments++;
          executedRuns += e.result.attempts.length;
        }
      }
      for (const p of store.listPatches(inv.id)) {
        patchesTotal++;
        if (p.status === 'validated') validatedFixes++;
      }
    }
    const repos = new Map<string, { repository: string; investigations: number; lastAt: string; source: string }>();
    for (const inv of all) {
      const r = repos.get(inv.repository) ?? { repository: inv.repository, investigations: 0, lastAt: inv.createdAt, source: inv.source };
      r.investigations++;
      if (inv.createdAt > r.lastAt) r.lastAt = inv.createdAt;
      repos.set(inv.repository, r);
    }
    return {
      totals: { investigations: all.length, experiments, executedRuns, validatedFixes, patchesTotal },
      byClassification: byClass,
      byVerdict,
      byStatus,
      bySource,
      recent: all.slice(0, 8),
      repositories: [...repos.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt)),
    };
  });

  // ------------------------------------------------------------- scenarios
  app.get('/api/scenarios', async () =>
    listScenarios().map((s) => ({ ...s, replayRecordedAt: loadReplay(s.id)?.recordedAt ?? null })),
  );

  // ------------------------------------------------------------- investigations
  app.get('/api/investigations', async (req) => {
    const q = z
      .object({
        q: z.string().max(200).optional(),
        status: z.string().max(20).optional(),
        classification: z.enum(CLASSIFICATIONS).optional(),
        verdict: z.enum(['confirmed', 'probable', 'inconclusive']).optional(),
        source: z.enum(['demo', 'github']).optional(),
      })
      .parse(req.query);
    return store.listInvestigations({ ...q, q: q.q?.trim() || undefined });
  });

  app.get('/api/investigations/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const bundle = store.bundle(id);
    if (!bundle) return sendError(reply, 404, 'Investigation not found');
    return { ...bundle, queuePosition: queue.position(id) };
  });

  app.get('/api/investigations/:id/log', async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = z.object({ from: z.coerce.number().int().min(1).optional(), to: z.coerce.number().int().min(1).optional() }).parse(req.query);
    const log = store.getLog(id);
    if (log === null) return sendError(reply, 404, 'No log stored for this investigation');
    const lines = splitLines(log);
    const from = q.from ?? 1;
    const to = Math.min(q.to ?? lines.length, lines.length, from + 2000);
    return { totalLines: lines.length, from, to, lines: lines.slice(from - 1, to) };
  });

  app.post('/api/investigations/demo', async (req, reply) => {
    if (!startLimit(req.ip)) return sendError(reply, 429, 'Too many investigations started from this address; try again later.');
    const body = z.object({ scenarioId: z.string().max(60), mode: ModeSchema, repeat: RepeatSchema }).parse(req.body ?? {});
    if (publicDemo && queue.depth >= 4) return sendError(reply, 503, 'The demo runner is busy; please retry in a minute.');
    const inv = await startDemo(store, queue, body.scenarioId, { mode: body.mode, repeat: body.repeat });
    return reply.status(202).send(inv);
  });

  app.post('/api/investigations/github', async (req, reply) => {
    if (!startLimit(req.ip)) return sendError(reply, 429, 'Too many investigations started from this address; try again later.');
    const body = z.object({ runUrl: z.string().url().max(300), mode: ModeSchema, repeat: RepeatSchema }).parse(req.body ?? {});
    const ref = parseRunUrl(body.runUrl);
    if (!ref) return sendError(reply, 400, 'Expected a GitHub Actions run URL like https://github.com/owner/repo/actions/runs/123456');
    if (!github.configured) return sendError(reply, 412, 'GitHub integration is not configured', 'Set GITHUB_TOKEN on the server (read-only scopes are enough to investigate).');
    if (publicDemo && !store.listRepositories().some((r) => r.fullName.toLowerCase() === `${ref.owner}/${ref.repo}`.toLowerCase())) {
      return sendError(reply, 403, 'This public demo only investigates allow-listed repositories.', 'Run Alibi locally to investigate any repository.');
    }
    const { investigation, duplicate } = await startFromGitHubRun(store, queue, github, ref, { mode: body.mode, repeat: body.repeat });
    return reply.status(duplicate ? 200 : 202).send({ ...investigation, duplicate });
  });

  app.post('/api/investigations/:id/rerun', async (req, reply) => {
    if (!startLimit(req.ip)) return sendError(reply, 429, 'Too many investigations started from this address; try again later.');
    const { id } = req.params as { id: string };
    const inv = store.getInvestigation(id);
    if (!inv) return sendError(reply, 404, 'Investigation not found');
    const body = z.object({ mode: ModeSchema, repeat: RepeatSchema }).parse(req.body ?? {});
    const opts = { mode: body.mode ?? inv.options.requestedMode, repeat: body.repeat ?? inv.options.repeat };
    if (inv.source === 'demo' && inv.scenarioId) return reply.status(202).send(await startDemo(store, queue, inv.scenarioId, opts));
    if (inv.runId) {
      const [owner, repo] = inv.repository.split('/');
      const ref = { owner, repo, runId: Number(inv.runId) };
      // A re-run is a new investigation of the same run; bypass dedupe by deleting the old key.
      store.db.prepare('UPDATE investigations SET dedupe_key = NULL WHERE id = ?').run(inv.id);
      const res = await startFromGitHubRun(store, queue, github, ref, opts);
      return reply.status(202).send(res.investigation);
    }
    return sendError(reply, 400, 'This investigation cannot be re-run');
  });

  app.delete('/api/investigations/:id', async (req, reply) => {
    if (publicDemo) return sendError(reply, 403, 'Deleting is disabled on the public demo.');
    const { id } = req.params as { id: string };
    const inv = store.getInvestigation(id);
    if (!inv) return sendError(reply, 404, 'Investigation not found');
    if (inv.status === 'running' || inv.status === 'queued') return sendError(reply, 409, 'Wait for the investigation to finish before deleting it.');
    store.deleteInvestigation(id);
    return reply.status(204).send();
  });

  app.get('/api/model-calls', async () => store.listModelCalls());

  // ------------------------------------------------------------- patches
  app.get('/api/patches/:id.diff', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = store.getPatch(id);
    if (!p) return sendError(reply, 404, 'Patch not found');
    return reply.header('Content-Type', 'text/x-diff; charset=utf-8').header('Content-Disposition', `attachment; filename="alibi-${p.id}.diff"`).send(p.diff);
  });

  app.post('/api/patches/:id/validate', async (req, reply) => {
    if (!startLimit(req.ip)) return sendError(reply, 429, 'Too many runs started from this address; try again later.');
    const { id } = req.params as { id: string };
    const p = store.getPatch(id);
    if (!p) return sendError(reply, 404, 'Patch not found');
    const inv = store.getInvestigation(p.investigationId)!;
    if (inv.status === 'running' || inv.status === 'queued') return sendError(reply, 409, 'Wait for the investigation to finish before re-validating.');
    if (p.status === 'validating') return sendError(reply, 409, 'Validation is already running for this patch.');
    const docker = await checkDocker();
    if (!docker.ok) return sendError(reply, 503, 'The sandbox runner is unavailable, so the fix cannot be validated.', docker.detail);
    store.updatePatch(p.id, { status: 'validating' });
    void new InvestigationRun({ store, llm, github }, inv.id).revalidate(p.id);
    return reply.status(202).send(store.getPatch(p.id));
  });

  app.post('/api/patches/:id/pull-request', async (req, reply) => {
    const { id } = req.params as { id: string };
    z.object({ confirm: z.literal(true) }).parse(req.body ?? {});
    const p = store.getPatch(id);
    if (!p) return sendError(reply, 404, 'Patch not found');
    const inv = store.getInvestigation(p.investigationId)!;
    if (publicDemo) return sendError(reply, 403, 'Pull requests are disabled on the public demo.');
    if (inv.source !== 'github') return sendError(reply, 412, 'Draft PRs are available for investigations of GitHub repositories.', 'Demo scenarios use local fixture repositories; download the .diff instead.');
    if (!github.configured) return sendError(reply, 412, 'GitHub integration is not configured', 'Set GITHUB_TOKEN with Contents: write and Pull requests: write.');
    if (p.status !== 'validated') return sendError(reply, 409, 'Only validated patches can be proposed as a pull request.');
    if (p.prUrl) return { url: p.prUrl, branch: p.prBranch, existing: true };
    const [owner, repo] = inv.repository.split('/');
    const repoInfo = await github.getRepo(owner, repo);
    // Rebuild full file contents from the validated patch applied at the failing commit.
    mkdirSync(join(config.dataDir, 'tmp'), { recursive: true });
    const dir = mkdtempSync(join(config.dataDir, 'tmp', 'pr-'));
    try {
      await checkout({ location: `https://github.com/${owner}/${repo}`, cacheKey: `gh:${owner}/${repo}` }, inv.commitSha, dir);
      const applied = await applyPatch(dir, p.diff);
      if (!applied.ok) return sendError(reply, 409, `Patch no longer applies: ${applied.detail}`);
      const files = p.files.filter((f) => existsSync(join(dir, f))).map((f) => ({ path: f, content: readFileSync(join(dir, f), 'utf8') }));
      const branch = `alibi/${inv.id.slice(-8)}-${p.strategy.replace(/_/g, '-')}`;
      const pr = await github.createDraftPr({
        owner, repo, baseBranch: inv.branch ?? repoInfo.default_branch, baseSha: inv.commitSha, branch,
        title: `[Alibi] ${p.title}`,
        body: [
          `Proposed by Alibi after investigating ${inv.runUrl ?? `run ${inv.runId}`}.`,
          '',
          `**Verdict:** ${inv.verdict} — ${inv.classification?.replace(/_/g, ' ')} (${inv.confidence?.label} evidence)`,
          `**Validation:** ${p.validation?.summary ?? 'n/a'}`,
          '',
          '**Evidence basis:**',
          ...(inv.confidence?.basis ?? []).map((b) => `- ${b}`),
          '',
          '_This is a draft. Review the evidence ledger before merging._',
        ].join('\n'),
        files,
      });
      store.updatePatch(p.id, { prUrl: pr.url, prBranch: branch });
      return { url: pr.url, branch };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ------------------------------------------------------------- webhooks
  const autoInvestigate = () => Boolean(store.getSettings().autoInvestigate ?? config.github.autoInvestigate);

  app.post('/api/webhooks/github', async (req, reply) => {
    const secret = config.github.webhookSecret;
    if (!secret) return sendError(reply, 503, 'Webhook secret is not configured (GITHUB_WEBHOOK_SECRET).');
    const raw = (req as FastifyRequest & { rawBody?: Buffer }).rawBody ?? Buffer.from('');
    if (!verifyWebhookSignature(secret, raw, req.headers['x-hub-signature-256'] as string | undefined)) {
      return sendError(reply, 401, 'Invalid webhook signature');
    }
    const event = String(req.headers['x-github-event'] ?? '');
    const delivery = String(req.headers['x-github-delivery'] ?? '');
    if (!delivery) return sendError(reply, 400, 'Missing X-GitHub-Delivery');
    if (!store.recordDelivery(delivery, event, 'received')) return reply.status(200).send({ duplicate: true });
    if (event === 'ping') {
      store.updateDelivery(delivery, 'ignored', null, 'ping');
      return { ok: true, pong: true };
    }
    const payload = req.body as any;
    if (event !== 'workflow_run' || payload?.action !== 'completed') {
      store.updateDelivery(delivery, 'ignored', null, `${event}/${payload?.action ?? ''}`);
      return { ok: true, ignored: true };
    }
    const run = payload.workflow_run;
    const repoFull: string = payload.repository?.full_name ?? '';
    if (run?.conclusion !== 'failure') {
      store.updateDelivery(delivery, 'ignored', null, `conclusion=${run?.conclusion}`);
      return { ok: true, ignored: true };
    }
    store.upsertRepository(repoFull, { url: payload.repository?.html_url, lastRunId: run.id });
    if (!autoInvestigate() || !github.configured) {
      store.updateDelivery(delivery, 'recorded', null, `Failed run ${run.id} recorded; auto-investigate is ${autoInvestigate() ? 'on but GitHub token is missing' : 'off'}.`);
      return reply.status(202).send({ ok: true, recorded: true });
    }
    const [owner, repo] = repoFull.split('/');
    try {
      const res = await startFromGitHubRun(store, queue, github, { owner, repo, runId: run.id }, {});
      store.updateDelivery(delivery, res.duplicate ? 'duplicate-run' : 'investigating', res.investigation.id);
      return reply.status(202).send({ ok: true, investigationId: res.investigation.id, duplicate: res.duplicate });
    } catch (err) {
      store.updateDelivery(delivery, 'error', null, (err as Error).message.slice(0, 300));
      return reply.status(202).send({ ok: false, error: (err as Error).message });
    }
  });

  app.get('/api/webhooks/deliveries', async () => store.listDeliveries());

  // ------------------------------------------------------------- settings / integrations
  const SettingsSchema = z.object({
    repeatDefault: z.number().int().min(2).max(30).optional(),
    defaultMode: z.enum(['auto', 'live', 'replay', 'heuristic']).optional(),
    autoInvestigate: z.boolean().optional(),
  });

  app.get('/api/settings', async () => ({
    repeatDefault: config.runner.repeatDefault,
    defaultMode: 'auto',
    autoInvestigate: config.github.autoInvestigate,
    ...store.getSettings(),
    readOnly: publicDemo,
    env: {
      modelOverrides: config.nebius.models,
      maxModelCalls: config.nebius.maxCallsPerInvestigation,
      maxLogChars: config.nebius.maxInputChars,
      runnerTimeoutSec: config.runner.timeoutSec,
    },
  }));

  app.put('/api/settings', async (req, reply) => {
    if (publicDemo) return sendError(reply, 403, 'Settings are read-only on the public demo.');
    const body = SettingsSchema.parse(req.body ?? {});
    for (const [k, v] of Object.entries(body)) if (v !== undefined) store.setSetting(k, v);
    return store.getSettings();
  });

  app.get('/api/repositories', async () => store.listRepositories());

  app.post('/api/repositories', async (req, reply) => {
    if (publicDemo) return sendError(reply, 403, 'Repository settings are read-only on the public demo.');
    const body = z.object({ fullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/) }).parse(req.body ?? {});
    if (github.configured) {
      const [owner, repo] = body.fullName.split('/');
      const info = await github.getRepo(owner, repo);
      store.upsertRepository(info.full_name, { url: info.html_url, private: info.private, defaultBranch: info.default_branch });
    } else {
      store.upsertRepository(body.fullName, { url: `https://github.com/${body.fullName}` });
    }
    return reply.status(201).send(store.listRepositories());
  });

  app.delete('/api/repositories/:owner/:repo', async (req, reply) => {
    if (publicDemo) return sendError(reply, 403, 'Repository settings are read-only on the public demo.');
    const { owner, repo } = req.params as { owner: string; repo: string };
    store.removeRepository(`${owner}/${repo}`);
    return reply.status(204).send();
  });

  app.post('/api/integrations/nebius/test', async (_req, reply) => {
    if (!llm.configured) return sendError(reply, 412, 'NEBIUS_API_KEY is not configured on the server.');
    const t0 = Date.now();
    const models = await llm.listModels(true);
    const model = models.triage ?? models.reasoning;
    if (!model) return { ok: false, models, error: 'No Nemotron text model found in the catalog.' };
    const res = await llm.chatJson({
      role: 'triage',
      model,
      system: 'Reply with a JSON object only.',
      user: 'Return {"status":"ok","model_family":"<your model family>"}.',
      schemaName: 'ping',
      jsonSchema: { type: 'object', properties: { status: { type: 'string' }, model_family: { type: 'string' } }, required: ['status'] },
      validator: z.object({ status: z.string(), model_family: z.string().optional() }),
      maxTokens: 400,
    });
    store.addModelCall({
      id: `mc_test_${Date.now()}`, investigationId: null, step: 'connection-test', role: 'triage', model, status: 'ok', startedAt: new Date(t0).toISOString(),
      durationMs: res.durationMs, inputChars: res.inputChars, promptTokens: res.promptTokens, completionTokens: res.completionTokens, attempts: res.attempts, error: null,
    });
    return { ok: true, model, latencyMs: res.durationMs, response: res.data, resolved: { triage: models.triage, reasoning: models.reasoning, deep: models.deep }, notes: models.notes };
  });

  app.post('/api/integrations/tavily/test', async (_req, reply) => {
    if (!tavilyConfigured()) return sendError(reply, 412, 'TAVILY_API_KEY is not configured on the server.');
    const res = await tavilySearch('GitHub Actions status incident history', { maxResults: 3 });
    return { ok: true, results: res.results.map((r) => ({ title: r.title, url: r.url })), responseTimeSec: res.responseTimeSec };
  });

  app.post('/api/integrations/github/test', async (_req, reply) => {
    if (!github.configured) return sendError(reply, 412, 'GITHUB_TOKEN is not configured on the server.');
    const me = await github.whoami();
    return { ok: true, login: me.login, scopes: me.scopes };
  });

  app.post('/api/integrations/runner/test', async () => checkDocker(true));

  app.get('/api/scenarios/:id/expected', async (req, reply) => {
    const s = getScenario((req.params as { id: string }).id);
    if (!s) return sendError(reply, 404, 'Scenario not found');
    return s.expected;
  });

  // ------------------------------------------------------------- web app
  const webDist = join(ROOT_DIR, 'web', 'dist');
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/', wildcard: true });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return sendError(reply, 404, 'Not found');
      return reply.type('text/html').send(readFileSync(join(webDist, 'index.html')));
    });
  }

  return app;
}

export type { Investigation };
