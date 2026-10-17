import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { openDatabase } from '../db/database.js';
import { newId, Store } from '../db/store.js';
import { freshInvestigation } from '../pipeline/investigate.js';
import { runTestExperiment, WorkspacePool } from '../pipeline/experiments.js';
import { buildDemoRepo } from '../scenarios/build.js';
import { buildDockerArgs, checkDocker } from './docker.js';
import { parseSurefireReports, testCommand, validateSelection } from './frameworks.js';
import { checkPatchPolicy, prepareWorkspace } from './workspace.js';

describe('container hardening', () => {
  it('builds docker args with isolation flags and no host secrets', () => {
    const args = buildDockerArgs({ image: 'node:20', command: ['node', '-v'], workspace: '/w', network: false, timeoutSec: 5 }, 'alibi-x');
    const s = args.join(' ');
    for (const flag of ['--network none', '--user 1000:1000', '--cap-drop ALL', '--security-opt no-new-privileges', '--read-only', '--pids-limit 512', '--memory', '--cpus']) expect(s).toContain(flag);
    expect(s).not.toContain('docker.sock');
    expect(s).not.toMatch(/NEBIUS|TAVILY|GITHUB_TOKEN/);
    expect(() => buildDockerArgs({ image: 'x', command: [], workspace: '/w', network: false, timeoutSec: 1, env: { 'A;rm': '1' } }, 'n')).toThrow();
  });
});

describe('test command construction', () => {
  it('passes test names as data, never through a shell', () => {
    const cmd = testCommand('jest', { selection: { file: 'test/a.test.js', name: 'x $(rm -rf /) `id`' }, seed: 7, resultFile: '/work/.alibi/r.json' });
    expect(cmd.slice(0, 2)).toEqual(['node', 'node_modules/jest/bin/jest.js']);
    expect(cmd).toContain('--seed=7');
    expect(cmd[cmd.indexOf('-t') + 1]).toBe('^x \\$\\(rm -rf /\\) `id`$');
    // The test path is positional, after "--", so it can never be parsed as an option.
    expect(cmd.slice(-3)).toEqual(['--runTestsByPath', '--', 'test/a.test.js']);
  });
  it('regression (QA F3): log-derived file names that look like options are refused', () => {
    for (const file of ['--watchAll.js', '-c.js', 'test/--config.js', 'test/-x/a.test.js']) expect(validateSelection('jest', { file })).toEqual({});
    expect(validateSelection('jest', { file: 'test/a-b.test.js' })).toEqual({ file: 'test/a-b.test.js' });
    expect(testCommand('jest', { selection: { file: '--watchAll.js' }, resultFile: '/r' })).not.toContain('--watchAll.js');
  });
  it('drops unsafe selections', () => {
    expect(validateSelection('jest', { file: '../../etc/passwd' })).toEqual({});
    expect(validateSelection('maven', { file: 'com.x.FooTest', name: 'bar; rm' })).toEqual({ file: 'com.x.FooTest' });
    expect(testCommand('maven', { selection: { file: 'com.x.FooTest', name: 'bar' }, resultFile: '' })).toContain('-Dtest=FooTest#bar');
  });
  it('parses surefire XML reports', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sf-'));
    mkdirSync(join(dir, 'target/surefire-reports'), { recursive: true });
    writeFileSync(join(dir, 'target/surefire-reports/TEST-a.xml'), '<testsuite><testcase name="ok" classname="A"/><testcase name="bad" classname="A"><failure message="x"/></testcase><testcase name="s" classname="A"><skipped/></testcase></testsuite>');
    expect(parseSurefireReports(dir)).toEqual({ total: 2, passed: 1, failed: 1, failedNames: ['A#bad'] });
  });
});

describe('patch policy', () => {
  it('blocks CI config, path traversal, mode changes and binaries', () => {
    expect(checkPatchPolicy('--- a/.github/workflows/ci.yml\n+++ b/.github/workflows/ci.yml\n').ok).toBe(false);
    expect(checkPatchPolicy('--- a/../x\n+++ b/../x\n').ok).toBe(false);
    expect(checkPatchPolicy('diff --git a/x b/x\nold mode 100644\nnew mode 100755\n').ok).toBe(false);
    expect(checkPatchPolicy('diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-a\n+b\n').ok).toBe(true);
  });

  const hunk = (file: string, minus: string, plus: string) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-${minus}\n+${plus}\n`;
  it('regression (QA A2): patches applied before install cannot change what the install step runs or fetches', () => {
    expect(checkPatchPolicy(hunk('pom.xml', '    <guava.version>21.0</guava.version>', '    <guava.version>20.0</guava.version>')).ok).toBe(true);
    expect(checkPatchPolicy(hunk('package.json', '    "uuid": "9.0.1"', '    "uuid": "3.4.0"')).ok).toBe(true);
    for (const [file, line] of [
      ['pom.xml', '<extensions><extension><groupId>x</groupId></extension></extensions>'],
      ['pom.xml', '<plugin><artifactId>exec-maven-plugin</artifactId></plugin>'],
      ['pom.xml', '<repository><url>https://evil.example/m2</url></repository>'],
      ['package.json', '    "uuid": "git+https://evil.example/uuid.git"'],
      ['package.json', '    "uuid": "file:../../outside"'],
      ['package-lock.json', '      "resolved": "https://evil.example/uuid-3.4.0.tgz",'],
    ]) {
      const r = checkPatchPolicy(hunk(file, 'x', line));
      expect(r.ok, `${file}: ${line}`).toBe(false);
    }
  });
});

describe('fresh validation workspaces', () => {
  it('regression (QA A2): the candidate patch is applied to the checkout before dependencies are installed', async () => {
    const { git } = await import('./git.js');
    mkdirSync(config.dataDir, { recursive: true });
    const repo = mkdtempSync(join(tmpdir(), 'alibi-ws-'));
    writeFileSync(join(repo, 'package.json'), '{\n  "dependencies": {\n    "uuid": "9.0.1"\n  }\n}\n');
    await git(['init', '-q', '-b', 'main'], { cwd: repo });
    await git(['add', '-A'], { cwd: repo });
    await git(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init'], { cwd: repo });
    const sha = (await git(['rev-parse', 'HEAD'], { cwd: repo })).trim();
    const pin = 'diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n@@ -2,3 +2,3 @@\n   "dependencies": {\n-    "uuid": "9.0.1"\n+    "uuid": "3.4.0"\n   }\n';
    // framework "unknown" has no install step, so this checks ordering and reporting without Docker.
    const ws = await prepareWorkspace({ location: repo, cacheKey: 'test:pin' }, sha, join(mkdtempSync(join(tmpdir(), 'alibi-wsd-')), 'w'), 'unknown', { patch: pin });
    expect(ws.patchApplied).toEqual({ ok: true, detail: 'Applied cleanly' });
    expect(readFileSync(join(ws.dir, 'package.json'), 'utf8')).toContain('"uuid": "3.4.0"');
    const bad = await prepareWorkspace({ location: repo, cacheKey: 'test:pin' }, sha, join(mkdtempSync(join(tmpdir(), 'alibi-wsd-')), 'w'), 'jest', { patch: pin.replace('9.0.1', '7.7.7') });
    expect(bad.patchApplied?.ok).toBe(false);
    expect(bad.install).toEqual([]);
  });

  it('regression (QA C9): model-written edits to test files are rejected even if a caller allowed them', async () => {
    const { git } = await import('./git.js');
    const { materialize } = await import('../pipeline/remediation.js');
    mkdirSync(config.dataDir, { recursive: true });
    const repo = mkdtempSync(join(tmpdir(), 'alibi-mat-'));
    mkdirSync(join(repo, 'test'));
    writeFileSync(join(repo, 'test', 'a.test.js'), "test('a', () => expect(1).toBe(1));\n");
    await git(['init', '-q', '-b', 'main'], { cwd: repo });
    await git(['add', '-A'], { cwd: repo });
    await git(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init'], { cwd: repo });
    const sha = (await git(['rev-parse', 'HEAD'], { cwd: repo })).trim();
    const cand = { title: 'model', strategy: 'code_patch' as const, origin: 'model' as const, rationale: '', edits: [{ path: 'test/a.test.js', content: "test('a', () => expect(2).toBe(2));\n" }] };
    const r = await materialize({ location: repo, cacheKey: 'test:mat' }, sha, join(mkdtempSync(join(tmpdir(), 'alibi-matd-')), 'w'), 'inv_t', cand, ['test/a.test.js']);
    expect(r.patch).toBeNull();
    expect(r.problem).toMatch(/test files are read-only/);
    // Deterministic candidates (allowedPaths undefined, e.g. a quarantine) may still edit tests.
    const q = await materialize({ location: repo, cacheKey: 'test:mat' }, sha, join(mkdtempSync(join(tmpdir(), 'alibi-matd-')), 'w'), 'inv_t', { ...cand, origin: 'deterministic', strategy: 'quarantine' });
    expect(q.patch).not.toBeNull();
  });
});

const docker = await checkDocker();
describe.skipIf(!docker.ok)('sandboxed execution (requires Docker)', () => {
  it('reproduces a failure, captures exit codes, and validates a fix against a regression test', async () => {
    const store = new Store(openDatabase(':memory:'));
    const repo = await buildDemoRepo('code-regression');
    const [parent, failing] = repo.commits.map((c) => c.sha);
    const inv = store.createInvestigation(freshInvestigation({ source: 'demo', repository: 'alibi-demo/pricing-engine', commitSha: failing }));
    const root = join(config.dataDir, 'workspaces', `test-${Date.now()}`);
    const pool = new WorkspacePool({ location: repo.repoPath, cacheKey: 'demo:code-regression' }, root, 'jest');
    const mk = (kind: 'reproduce' | 'validate_patch', sha: string) =>
      store.addExperiment({ id: newId('exp'), investigationId: inv.id, hypothesisKey: null, kind, title: kind, reason: '', status: 'queued', backend: 'docker', command: null, environment: null, commitSha: sha, testSelection: null, plannedAttempts: 1, startedAt: null, finishedAt: null, durationMs: null, result: null, observation: null, effect: null, patchId: null });
    const sel = { file: 'test/discounts.test.js', name: 'discountRate applies 10% at exactly the $100.00 threshold' };

    const repro = await runTestExperiment({ store, experiment: mk('reproduce', failing), workspace: await pool.get(failing), selection: sel, seeds: [undefined] });
    expect(repro.status).toBe('failed');
    expect(repro.result!.attempts[0].exitCode).toBe(1);
    expect(repro.result!.attempts[0].tests).toMatchObject({ total: 1, failed: 1 });
    expect(repro.environment).toMatchObject({ network: 'none', user: '1000:1000' });

    const fix = [
      '--- a/src/discounts.js',
      '+++ b/src/discounts.js',
      '@@ -11,3 +11,3 @@ const TIERS = [',
      ' function discountRate(subtotalCents) {',
      '-  const tier = TIERS.find((t) => subtotalCents > t.minCents);',
      '+  const tier = TIERS.find((t) => subtotalCents >= t.minCents);',
      '   return tier ? tier.rate : 0;',
      '',
    ].join('\n');
    // Applied in the fresh checkout before `npm ci`, as validatePatch does.
    const ws = await pool.fresh(failing, 'patch', fix);
    expect(ws.patchApplied?.ok).toBe(true);
    expect(ws.install.every((i) => i.exitCode === 0)).toBe(true);
    const validated = await runTestExperiment({ store, experiment: mk('validate_patch', failing), workspace: ws, selection: sel, seeds: [undefined] });
    expect(validated.status).toBe('passed');
    expect(validated.result!.attempts[0].exitCode).toBe(0);
    expect(parent).toMatch(/^[0-9a-f]{40}$/);
  }, 240_000);
});
