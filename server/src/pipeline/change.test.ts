import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyzeDiff } from '../analysis/diff.js';
import { config } from '../config.js';
import { openDatabase } from '../db/database.js';
import { Store } from '../db/store.js';
import type { Experiment } from '../domain/types.js';
import { GitHubClient } from '../integrations/github.js';
import { TokenFactoryClient } from '../llm/client.js';
import { checkDocker } from '../runner/docker.js';
import { buildDemoRepo } from '../scenarios/build.js';
import { decideFailingChange, decidePassingChange, notTestedFor, parseRepoUrl, testScopeConcerns } from './change.js';
import { IntakeError, startChange } from './intake.js';
import { InvestigationRun } from './investigate.js';
import type { InvestigationQueue } from './queue.js';

const counts = (total: number, failed = 0) => ({ total, passed: total - failed, failed, failedNames: [] });
const queue = { enqueue: () => undefined } as unknown as InvestigationQueue;

describe('change verification rules', () => {
  it('accepts only public GitHub repository URLs', () => {
    expect(parseRepoUrl('https://github.com/acme/widgets.git')).toEqual({ owner: 'acme', repo: 'widgets', url: 'https://github.com/acme/widgets' });
    for (const bad of ['http://github.com/a/b', 'https://gitlab.com/a/b', 'https://github.com/a/b/tree/main', 'https://github.com/../b', 'file:///etc', 'https://github.com/a/b?x=1']) {
      expect(parseRepoUrl(bad)).toBeNull();
    }
  });

  it('a passing suite is "no regression observed" only when scope did not shrink and tests were not edited', () => {
    expect(decidePassingChange({ status: 'passed', tests: counts(5) }, { status: 'passed', tests: counts(5) }, []).outcome).toBe('no_regression_observed');
    expect(decidePassingChange({ status: 'passed', tests: counts(5) }, { status: 'passed', tests: counts(5) }, []).detail).toMatch(/not proof that the change is correct/);
    expect(decidePassingChange({ status: 'passed', tests: counts(4) }, { status: 'failed', tests: counts(5, 1) }, []).outcome).toBe('inconclusive');
    expect(decidePassingChange({ status: 'passed', tests: counts(5) }, { status: 'passed', tests: counts(5) }, ['The change adds a skip or focus marker in test/a.test.js.']).outcome).toBe('inconclusive');
    expect(decidePassingChange({ status: 'passed', tests: counts(5) }, { status: 'error', tests: null }, []).outcome).toBe('inconclusive');
    expect(decidePassingChange({ status: 'passed', tests: null }, { status: 'passed', tests: counts(5) }, []).outcome).toBe('inconclusive');
    expect(decidePassingChange({ status: 'passed', tests: counts(0) }, { status: 'passed', tests: counts(0) }, []).outcome).toBe('inconclusive');
  });

  it('flags edited or skipped tests, not new ones', () => {
    const d = (file: string, body: string) => analyzeDiff(`diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,3 +1,3 @@\n${body}\n`, `1\t1\t${file}`);
    expect(testScopeConcerns(d('test/a.test.js', "-  expect(rate(100)).toBe(0.1);\n+  expect(rate(100)).toBe(0);"))).toEqual(['The change modifies or removes existing tests or assertions in test/a.test.js.']);
    expect(testScopeConcerns(d('test/a.test.js', "-test('a', () => {\n+test.skip('a', () => {"))).toHaveLength(2);
    expect(testScopeConcerns(d('tests/test_a.py', '+@pytest.mark.skip(reason="later")\n def test_a():'))).toEqual(['The change adds a skip or focus marker in tests/test_a.py.']);
    expect(testScopeConcerns(d('test/a.test.js', "+test('new case', () => expect(1).toBe(1));"))).toEqual([]);
    expect(testScopeConcerns(d('src/a.js', '-  return a;\n+  return b;'))).toEqual([]);
  });

  it('a regression needs a failing head, a passing base for the same selection, and a regression diagnosis', () => {
    const exp = (id: string, kind: Experiment['kind'], sha: string, failures: number, n = 3) =>
      ({ id, kind, commitSha: sha, result: { attempts: Array.from({ length: n }, (_, i) => ({ index: i + 1, exitCode: i < failures ? 1 : 0, passed: i >= failures, timedOut: false, durationMs: 1, tests: { ...counts(1, i < failures ? 1 : 0), failedNames: i < failures ? ['t'] : [] }, outputTail: '' })), passes: n - failures, failures } }) as unknown as Experiment;
    const base = { verdict: 'probable' as const, classification: 'code_regression' as const, sandboxRan: true, baseSuiteId: 'b0', headSha: 'h'.repeat(40), baseSha: 'b'.repeat(40) };
    const head = exp('h1', 'reproduce', base.headSha, 1, 1);
    expect(decideFailingChange({ ...base, experiments: [head, exp('b0', 'compare_parent', base.baseSha, 0, 1), exp('b1', 'compare_parent', base.baseSha, 0)] })).toMatchObject({ outcome: 'regression' });
    expect(decideFailingChange({ ...base, experiments: [head, exp('b1', 'compare_parent', base.baseSha, 2)] }).outcome).toBe('inconclusive');
    expect(decideFailingChange({ ...base, classification: 'flaky_test', experiments: [head, exp('b1', 'compare_parent', base.baseSha, 0)] }).outcome).toBe('inconclusive');
    expect(decideFailingChange({ ...base, verdict: 'inconclusive', experiments: [head, exp('b1', 'compare_parent', base.baseSha, 0)] }).outcome).toBe('inconclusive');
    expect(decideFailingChange({ ...base, sandboxRan: false, experiments: [] }).outcome).toBe('blocked');
    expect(decideFailingChange({ ...base, experiments: [head] }).outcome).toBe('inconclusive');
  });

  it('always states what was not examined, including authorship', () => {
    const n = notTestedFor({ outcome: 'no_regression_observed', image: 'node:20', headTests: counts(5), diffTruncated: false });
    expect(n.join('\n')).toMatch(/5 at the changed revision/);
    expect(n.join('\n')).toMatch(/behaviour, not authorship/);
  });
});

describe('change verification intake', () => {
  it('validates origins and revisions before anything is queued', async () => {
    const store = new Store(openDatabase(':memory:'));
    const err = (p: Promise<unknown>) => p.then(() => null, (e: IntakeError) => e.message);
    expect(await err(startChange(store, queue, { base: 'abc1234', head: 'def5678' }))).toMatch(/exactly one/);
    expect(await err(startChange(store, queue, { repoUrl: 'https://github.com/a/b', scenarioId: 'code-regression', base: 'abc1234', head: 'def5678' }))).toMatch(/exactly one/);
    expect(await err(startChange(store, queue, { repoUrl: 'https://evil.example/a/b', base: 'abc1234', head: 'def5678' }))).toMatch(/public GitHub repository/);
    expect(await err(startChange(store, queue, { repoUrl: 'https://github.com/a/b', base: 'main', head: 'def5678' }))).toMatch(/commit SHA/);
    expect(await err(startChange(store, queue, { repoUrl: 'https://github.com/a/b', base: '--upload-pack=x', head: 'def5678' }))).toMatch(/commit SHA/);
    expect(await err(startChange(store, queue, { repoUrl: 'https://github.com/a/b', base: 'abc1234', head: 'abc1234' }))).toMatch(/same/);
    expect(await err(startChange(store, queue, { investigationId: 'inv_missing' }))).toMatch(/not found/);
    const inv = await startChange(store, queue, { repoUrl: 'https://github.com/a/b.git', base: 'ABC1234', head: 'def5678' });
    expect(inv).toMatchObject({ source: 'change', repository: 'a/b', commitSha: 'def5678', parentSha: 'abc1234' });
    expect(inv.change).toMatchObject({ origin: { kind: 'github', url: 'https://github.com/a/b' }, requested: { base: 'abc1234', head: 'def5678' }, outcome: null });
  });
});

const docker = await checkDocker();
const saved = { dataDir: config.dataDir, tavily: config.tavily.apiKey, loop: config.agentLoop.enabled };
const testDir = join(saved.dataDir, `test-change-${process.pid}`);

describe.skipIf(!docker.ok)('change verification in the pipeline (real sandbox, heuristic reasoning)', () => {
  beforeAll(() => {
    mkdirSync(testDir, { recursive: true });
    config.dataDir = testDir;
    config.tavily.apiKey = undefined;
    config.agentLoop.enabled = false;
  });
  afterAll(() => {
    config.dataDir = saved.dataDir;
    config.tavily.apiKey = saved.tavily;
    config.agentLoop.enabled = saved.loop;
    rmSync(testDir, { recursive: true, force: true });
  });

  async function verify(base: string, head: string) {
    const store = new Store(openDatabase(':memory:'));
    const inv = await startChange(store, queue, { scenarioId: 'code-regression', base, head }, { mode: 'heuristic', repeat: 3 });
    const llm = new TokenFactoryClient({ ...config.nebius, apiKey: undefined, maxRetries: 0 });
    await new InvestigationRun({ store, llm, github: new GitHubClient(undefined) }, inv.id).run();
    return store.bundle(inv.id)!;
  }

  it('a change that breaks a boundary is a regression: head fails, base passes, scope recorded', async () => {
    const repo = await buildDemoRepo('code-regression');
    const [base, head] = repo.commits.map((c) => c.sha);
    const b = await verify(base.slice(0, 10), head);
    const inv = b.investigation;
    expect(inv.status).not.toBe('failed');
    expect(inv.change).toMatchObject({ baseSha: base, headSha: head, outcome: 'regression' });
    expect(inv.commitSha).toBe(head);
    expect(inv.parentSha).toBe(base);
    const [h, bs] = inv.change!.examined;
    expect(h).toMatchObject({ revision: 'head', sha: head, status: 'failed' });
    expect(bs).toMatchObject({ revision: 'base', sha: base, status: 'passed' });
    expect(b.experiments.find((e) => e.id === h.experimentId)!.environment).toMatchObject({ network: 'none' });
    expect(inv.change!.notTested.join(' ')).toMatch(/not authorship/);
    expect(b.evidence.some((e) => e.title.startsWith('Change verification: regression'))).toBe(true);
  }, 600_000);

  it('the reverse change (the fix) passes: no regression observed, nothing proposed', async () => {
    const repo = await buildDemoRepo('code-regression');
    const [base, head] = repo.commits.map((c) => c.sha);
    const b = await verify(head, base);
    expect(b.investigation.change).toMatchObject({ outcome: 'no_regression_observed', fix: 'NONE' });
    expect(b.investigation.status).toBe('completed');
    expect(b.hypotheses).toHaveLength(0);
    expect(b.patches).toHaveLength(0);
  }, 600_000);

  it('a revision that does not exist is blocked, and nothing runs', async () => {
    const repo = await buildDemoRepo('code-regression');
    const b = await verify(repo.commits[0].sha, 'deadbeefdeadbeef');
    expect(b.investigation.change).toMatchObject({ outcome: 'blocked' });
    expect(b.investigation.change!.outcomeDetail).toMatch(/head deadbeefdeadbeef is not available/);
    expect(b.investigation.status).toBe('inconclusive');
    expect(b.experiments).toHaveLength(0);
  }, 120_000);
});
