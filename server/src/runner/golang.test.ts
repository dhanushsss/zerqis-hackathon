import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dependencyChanges } from '../analysis/diff.js';
import { extractFacts } from '../analysis/logs.js';
import { config } from '../config.js';
import { openDatabase } from '../db/database.js';
import { newId, Store } from '../db/store.js';
import type { Experiment } from '../domain/types.js';
import { runTestExperiment, WorkspacePool } from '../pipeline/experiments.js';
import { freshInvestigation } from '../pipeline/investigate.js';
import { isTestFile, pinCandidate, quarantineCandidate } from '../pipeline/remediation.js';
import { checkDocker } from './docker.js';
import { detectFramework, envFor, imageFor, installCommands, installEnvFor, testCommand, validateSelection } from './frameworks.js';
import { git } from './git.js';
import { findGoTestFile, goLayout, goRunPattern, packageDir, parseGoTestJson } from './golang.js';
import { checkPatchPolicy } from './workspace.js';

const files = (m: Record<string, string>) => (p: string) => m[p] ?? null;
const MOD = 'module example.com/shop\n\ngo 1.22\n';

describe('go layout policy', () => {
  it('accepts a root module, with go.sum when it requires modules', () => {
    expect(goLayout(files({ 'go.mod': MOD }))).toEqual({ ok: true, module: 'example.com/shop', goVersion: '1.22' });
    const withDeps = `${MOD}\nrequire golang.org/x/exp v0.0.0-20230213192124-5e25df0256eb\n`;
    expect(goLayout(files({ 'go.mod': withDeps, 'go.sum': 'x' })).ok).toBe(true);
    expect(goLayout(files({ 'go.mod': withDeps }))).toMatchObject({ ok: false, reason: expect.stringMatching(/go\.sum is missing/) });
  });

  it.each([
    [{}, /No go\.mod/],
    [{ 'go.mod': MOD, 'go.work': 'go 1.22\nuse ./a\n' }, /workspaces \(go\.work\)/],
    [{ 'go.mod': MOD, 'vendor/modules.txt': '# x' }, /Vendored dependencies/],
    [{ 'go.mod': 'go 1.22\n' }, /module path/],
    [{ 'go.mod': 'module x.com/a\n' }, /go version/],
    [{ 'go.mod': 'module x.com/a\n\ngo 1.26\n' }, /requires Go 1\.26, newer than the sandbox's Go 1\.24/],
    [{ 'go.mod': `${MOD}replace example.com/lib => ../lib\n` }, /local path \(\.\.\/lib\)/],
    [{ 'go.mod': `${MOD}replace (\n\texample.com/lib v1.0.0 => ./forks/lib\n)\n` }, /local path \(\.\/forks\/lib\)/],
  ])('refuses %j', (m, reason) => {
    expect(goLayout(files(m as Record<string, string>))).toMatchObject({ ok: false, reason: expect.stringMatching(reason) });
  });

  it('allows a replace that points at another published module version', () => {
    expect(goLayout(files({ 'go.mod': `${MOD}replace example.com/lib => example.com/fork v1.2.3\n` })).ok).toBe(true);
  });
});

describe('go selections and commands', () => {
  it('detects Go modules after Maven and Jest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alibi-go-'));
    writeFileSync(join(dir, 'go.mod'), MOD);
    expect(detectFramework(dir)).toBe('go');
  });

  it('accepts only ./-rooted package directories and Test names; log-derived values never become flags', () => {
    expect(validateSelection('go', { file: './internal/rates', name: 'TestRate/at_1kg' })).toEqual({ file: './internal/rates', name: 'TestRate/at_1kg' });
    for (const file of ['-exec=sh', '../x', './a/../b', '/etc', './a b', 'internal/rates', './testdata/x', './-v']) {
      expect(validateSelection('go', { file }).file, file).toBeUndefined();
    }
    for (const name of ['-test.run=.', 'Rate', 'TestA;rm', 'TestA\n', 'TestA$(id)']) {
      expect(validateSelection('go', { name }).name, name).toBeUndefined();
    }
    // A check never carries a file or a name.
    expect(validateSelection('go', { check: 'build', file: './x', name: 'TestX' })).toEqual({ check: 'build' });
    expect(validateSelection('go', { check: 'typecheck' })).toEqual({});
  });

  it('builds fixed argv templates', () => {
    expect(testCommand('go', { selection: {}, resultFile: '' })).toEqual(['go', 'test', '-json', '-count=1', './...']);
    expect(testCommand('go', { selection: { file: './rates', name: 'TestRate/at_1kg' }, seed: 65537, resultFile: '' })).toEqual([
      'go', 'test', '-json', '-count=1', '-shuffle=65537', '-run', '^TestRate$/^at_1kg$', './rates',
    ]);
    expect(testCommand('go', { selection: { check: 'build' }, resultFile: '' })).toEqual(['go', 'build', './...']);
    expect(testCommand('go', { selection: { file: '-exec=sh' }, resultFile: '' })).toEqual(['go', 'test', '-json', '-count=1', './...']);
    expect(goRunPattern('TestA.b')).toBe('^TestA\\.b$');
  });

  it('pins the image, keeps the proxy off for tests, and on only for go mod download', () => {
    expect(imageFor('go')).toBe(config.runner.goImage);
    expect(config.runner.goImage).toMatch(/^golang:1\.24\.9-bookworm@sha256:[0-9a-f]{64}$/);
    expect(envFor('go')).toMatchObject({ GOPROXY: 'off', GOFLAGS: '-mod=readonly -modcacherw', GOTOOLCHAIN: 'local', GOMODCACHE: '/cache/gomod' });
    expect(installEnvFor('go')).toMatchObject({ GOPROXY: 'https://proxy.golang.org', GOSUMDB: 'sum.golang.org', GOTOOLCHAIN: 'local' });
    expect(installCommands('go', false)).toEqual([['go', 'mod', 'download']]);
    expect(installEnvFor('jest')).toEqual(envFor('jest'));
  });

  it('maps import paths to package directories inside the module only', () => {
    expect(packageDir('example.com/shop/internal/rates', 'example.com/shop')).toBe('./internal/rates');
    expect(packageDir('example.com/shop', 'example.com/shop')).toBe('.');
    expect(packageDir('example.com/other/x', 'example.com/shop')).toBeNull();
  });
});

// Captured from `go test -json ./...` in the pinned image (Go 1.24.9).
const JSON_RUN = [
  '{"ImportPath":"example.com/probe/broken","Action":"build-output","Output":"# example.com/probe/broken\\n"}',
  '{"ImportPath":"example.com/probe/broken","Action":"build-output","Output":"broken/broken.go:3:23: undefined: undefinedThing\\n"}',
  '{"ImportPath":"example.com/probe/broken","Action":"build-fail"}',
  '{"Action":"fail","Package":"example.com/probe/broken","Elapsed":0.001,"FailedBuild":"example.com/probe/broken"}',
];
const JSON_TESTS = [
  '{"Action":"pass","Package":"example.com/probe/calc","Test":"TestAdd","Elapsed":0}',
  '{"Action":"run","Package":"example.com/probe/calc","Test":"TestBad/case_one"}',
  '{"Action":"output","Package":"example.com/probe/calc","Test":"TestBad/case_one","Output":"    calc_test.go:7: Add(2,2) = 4, want 5\\n"}',
  '{"Action":"fail","Package":"example.com/probe/calc","Test":"TestBad/case_one","Elapsed":0}',
  '{"Action":"pass","Package":"example.com/probe/calc","Test":"TestBad/case_two","Elapsed":0}',
  '{"Action":"fail","Package":"example.com/probe/calc","Test":"TestBad","Elapsed":0}',
  '{"Action":"skip","Package":"example.com/probe/calc","Test":"TestLater","Elapsed":0}',
  '{"Action":"fail","Package":"example.com/probe/calc","Elapsed":0.002}',
];

describe('go results', () => {
  it('counts leaf tests from go test -json and names failures by package and test', () => {
    expect(parseGoTestJson(JSON_TESTS.join('\n')).counts).toEqual({ total: 3, passed: 2, failed: 1, failedNames: ['example.com/probe/calc TestBad/case_one'] });
  });

  it('reports a failed build instead of counts, with the compiler output', () => {
    const r = parseGoTestJson([...JSON_RUN, ...JSON_TESTS].join('\n'));
    expect(r.counts).toBeNull();
    expect(r.buildFailed).toEqual(['example.com/probe/broken']);
    expect(r.buildOutput).toContain('broken/broken.go:3:23: undefined: undefinedThing');
  });

  it('returns null for output that is not go test -json', () => {
    expect(parseGoTestJson('go: example.com/x@v1: module lookup disabled by GOPROXY=off').counts).toBeNull();
  });
});

describe('go log facts', () => {
  it('extracts failing (sub)tests, the first diagnostic, and the framework from text output', () => {
    const log = [
      '##[group]Run go test ./...',
      '--- FAIL: TestShippingRate (0.00s)',
      '    --- FAIL: TestShippingRate/exactly_1kg (0.00s)',
      '        rates_test.go:21: ShippingCents(1.0) = 899, want 499',
      'FAIL',
      'FAIL\texample.com/shop/rates\t0.004s',
      'ok  \texample.com/shop/cart\t0.002s',
      '##[error]Process completed with exit code 1.',
    ].join('\n');
    const f = extractFacts(log);
    expect(f.framework).toBe('go');
    expect(f.failingTests).toEqual([{ name: 'TestShippingRate/exactly_1kg' }]);
    expect(f.assertion).toBe('rates_test.go:21: ShippingCents(1.0) = 899, want 499');
    expect(f.compileErrors).toEqual([]);
    expect(f.signature).toMatch(/^go: TestShippingRate\/exactly_1kg/);
  });

  it('extracts compiler errors only under a "# package" header, and tells go build from go test failures', () => {
    const build = extractFacts(['Run go build ./...', '# example.com/shop/rates', 'rates/rates.go:14:9: undefined: slices.Comparator', '##[error]Process completed with exit code 1.'].join('\n'));
    expect(build).toMatchObject({ framework: 'go', compileTool: 'go', goTestBuildFailed: false });
    expect(build.compileErrors).toEqual([{ file: 'rates/rates.go', line: 14, message: 'undefined: slices.Comparator' }]);
    const tests = extractFacts(['# example.com/shop/rates [example.com/shop/rates.test]', 'rates/rates_test.go:9:2: undefined: OldName', 'FAIL\texample.com/shop/rates [build failed]'].join('\n'));
    expect(tests).toMatchObject({ compileTool: 'go', goTestBuildFailed: true });
    // An indented test diagnostic is not a compiler error.
    expect(extractFacts('--- FAIL: TestX (0.00s)\n    x_test.go:3: boom\n').compileErrors).toEqual([]);
  });
});

const GO_DIFF = `diff --git a/go.mod b/go.mod
--- a/go.mod
+++ b/go.mod
@@ -3,3 +3,3 @@ module example.com/shop
 go 1.22

-require golang.org/x/exp v0.0.0-20230213192124-5e25df0256eb
+require golang.org/x/exp v0.0.0-20230728194245-b0cb94b80691
diff --git a/go.sum b/go.sum
--- a/go.sum
+++ b/go.sum
@@ -1,2 +1,2 @@
-golang.org/x/exp v0.0.0-20230213192124-5e25df0256eb h1:OLD=
-golang.org/x/exp v0.0.0-20230213192124-5e25df0256eb/go.mod h1:OLDMOD=
+golang.org/x/exp v0.0.0-20230728194245-b0cb94b80691 h1:NEW=
+golang.org/x/exp v0.0.0-20230728194245-b0cb94b80691/go.mod h1:NEWMOD=
`;

describe('go dependencies and remediation', () => {
  it('detects go.mod version changes with the previous go.sum lines', () => {
    expect(dependencyChanges(GO_DIFF)).toEqual([
      {
        ecosystem: 'go', name: 'golang.org/x/exp', from: 'v0.0.0-20230213192124-5e25df0256eb', to: 'v0.0.0-20230728194245-b0cb94b80691', file: 'go.mod',
        removedLine: 'require golang.org/x/exp v0.0.0-20230213192124-5e25df0256eb', addedLine: 'require golang.org/x/exp v0.0.0-20230728194245-b0cb94b80691',
        previousSums: ['golang.org/x/exp v0.0.0-20230213192124-5e25df0256eb h1:OLD=', 'golang.org/x/exp v0.0.0-20230213192124-5e25df0256eb/go.mod h1:OLDMOD='],
      },
    ]);
  });

  it('pins the previous version and restores its checksums', () => {
    const changes = dependencyChanges(GO_DIFF);
    const pin = pinCandidate({ files: [], diff: GO_DIFF, truncated: false, dependencyChanges: changes, onlyDocs: false }, files({
      'go.mod': `${MOD}\nrequire golang.org/x/exp v0.0.0-20230728194245-b0cb94b80691\n`,
      'go.sum': 'golang.org/x/exp v0.0.0-20230728194245-b0cb94b80691 h1:NEW=\ngolang.org/x/exp v0.0.0-20230728194245-b0cb94b80691/go.mod h1:NEWMOD=\n',
    }))!;
    expect(pin.title).toBe('Pin golang.org/x/exp back to v0.0.0-20230213192124-5e25df0256eb');
    expect(pin.edits[0].content).toContain('require golang.org/x/exp v0.0.0-20230213192124-5e25df0256eb');
    expect(pin.edits[1].path).toBe('go.sum');
    expect(pin.edits[1].content).toContain('5e25df0256eb h1:OLD=');
    // Without the old checksums a pin cannot be verified, so none is offered.
    expect(pinCandidate({ files: [], diff: '', truncated: false, dependencyChanges: changes.map((c) => ({ ...c, previousSums: [] })), onlyDocs: false }, files({ 'go.mod': 'require golang.org/x/exp v0.0.0-20230728194245-b0cb94b80691', 'go.sum': '' }))).toBeNull();
  });

  it('quarantines a flaky Go test with t.Skip and finds its file', () => {
    const src = 'package rates\n\nimport "testing"\n\nfunc TestRetryOrder(tt *testing.T) {\n\ttt.Parallel()\n}\n';
    const q = quarantineCandidate({ testFile: 'rates/retry_test.go', testFullName: 'TestRetryOrder/sub', content: src, investigationId: 'inv_1', failureSummary: 'failed 3/10 runs' })!;
    expect(q.edits[0].content).toContain('func TestRetryOrder(tt *testing.T) {\n\t// Re-enable once the nondeterminism is removed.\n\ttt.Skip("Quarantined by Zerqis (investigation inv_1): failed 3/10 runs")\n\ttt.Parallel()');
    const dir = mkdtempSync(join(tmpdir(), 'alibi-gofind-'));
    for (const [p, c] of Object.entries({ 'rates/retry_test.go': src, 'vendor/x/retry_test.go': src, 'other/a_test.go': 'package other\n' })) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), c);
    }
    expect(findGoTestFile(dir, 'TestRetryOrder/sub')).toBe('rates/retry_test.go');
    expect(findGoTestFile(dir, 'TestMissing')).toBeNull();
  });

  it('treats _test.go files and testdata as tests that model-written fixes may not edit', () => {
    expect(isTestFile('rates/rates_test.go')).toBe(true);
    expect(isTestFile('rates/testdata/golden.json')).toBe(true);
    expect(isTestFile('rates/rates.go')).toBe(false);
  });

  it('patch policy blocks local replaces, go.work, and added build constraints, but allows version bumps', () => {
    const p = (file: string, added: string) => checkPatchPolicy(`diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1,2 @@\n x\n+${added}\n`);
    expect(p('go.mod', 'replace example.com/lib => ../lib').reasons.join()).toMatch(/local paths/);
    expect(p('go.mod', '\texample.com/lib v1.0.0 => /tmp/lib').reasons.join()).toMatch(/local paths/);
    expect(p('go.work', 'use ./x').reasons.join()).toMatch(/not allowed: go\.work/);
    expect(p('rates/rates.go', '//go:build ignore').reasons.join()).toMatch(/build constraints/);
    expect(p('go.mod', 'require golang.org/x/exp v0.0.0-20230213192124-5e25df0256eb').ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Real sandbox (pinned Go image). Standard library only, so no module proxy is needed.

const docker = await checkDocker();

async function commitRepo(fileMap: Record<string, string>): Promise<{ repo: string; sha: string }> {
  const repo = mkdtempSync(join(tmpdir(), 'alibi-gorepo-'));
  await git(['init', '-q', '-b', 'main'], { cwd: repo });
  for (const [p, c] of Object.entries(fileMap)) {
    mkdirSync(dirname(join(repo, p)), { recursive: true });
    writeFileSync(join(repo, p), c);
  }
  await git(['add', '-A'], { cwd: repo });
  await git(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'init'], { cwd: repo });
  return { repo, sha: (await git(['rev-parse', 'HEAD'], { cwd: repo })).trim() };
}

const blankExp = (investigationId: string, sha: string): Experiment => ({ id: newId('exp'), investigationId, hypothesisKey: null, kind: 'reproduce', title: 'reproduce', reason: '', status: 'queued', backend: 'docker', command: null, environment: null, commitSha: sha, testSelection: null, plannedAttempts: 1, startedAt: null, finishedAt: null, durationMs: null, result: null, observation: null, effect: null, patchId: null });

describe.skipIf(!docker.ok)('go sandbox (requires Docker and the pinned Go image)', () => {
  it('runs a selected test offline with a shuffle seed, parses structured results, and builds', async () => {
    mkdirSync(config.dataDir, { recursive: true });
    const { repo, sha } = await commitRepo({
      'go.mod': 'module example.com/calc\n\ngo 1.22\n',
      'calc/calc.go': 'package calc\n\nfunc Add(a, b int) int { return a - b }\n',
      'calc/calc_test.go': 'package calc\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {\n\tt.Run("two_and_two", func(t *testing.T) {\n\t\tif got := Add(2, 2); got != 4 {\n\t\t\tt.Errorf("Add(2, 2) = %d, want 4", got)\n\t\t}\n\t})\n}\n\nfunc TestZero(t *testing.T) {\n\tif Add(0, 0) != 0 {\n\t\tt.Fatal("zero")\n\t}\n}\n',
    });
    const store = new Store(openDatabase(':memory:'));
    const inv = store.createInvestigation(freshInvestigation({ source: 'demo', repository: 't/go', commitSha: sha }));
    const pool = new WorkspacePool({ location: repo, cacheKey: 'test:go' }, join(config.dataDir, 'workspaces', `go-${Date.now()}`), 'go');
    const ws = await pool.get(sha);
    expect(ws.unsupported).toBeUndefined();
    expect(ws.install.map((i) => i.exitCode)).toEqual([0]);

    const r = await runTestExperiment({ store, experiment: store.addExperiment(blankExp(inv.id, sha)), workspace: ws, selection: { file: './calc', name: 'TestAdd/two_and_two' }, seeds: [65537, 131074] });
    expect(r.status).toBe('failed');
    expect(r.command).toEqual(['go', 'test', '-json', '-count=1', '-shuffle=131074', '-run', '^TestAdd$/^two_and_two$', './calc']);
    expect(r.result!.attempts.map((a) => a.seed)).toEqual([65537, 131074]);
    expect(r.result!.attempts[0]).toMatchObject({ exitCode: 1, tests: { total: 1, passed: 0, failed: 1, failedNames: ['example.com/calc/calc TestAdd/two_and_two'] } });
    expect(r.result!.attempts[0].outputTail).toContain('Add(2, 2) = 0, want 4');
    expect(r.environment).toMatchObject({ image: config.runner.goImage, network: 'none', user: '1000:1000', readOnlyRoot: true });

    const build = await runTestExperiment({ store, experiment: store.addExperiment(blankExp(inv.id, sha)), workspace: ws, selection: { check: 'build' }, seeds: [undefined] });
    expect(build.status).toBe('passed');
    expect(build.command).toEqual(['go', 'build', './...']);
    expect(build.result!.attempts[0].tests).toBeNull();

    // A package that is not a directory in this checkout is not run.
    const missing = await runTestExperiment({ store, experiment: store.addExperiment(blankExp(inv.id, sha)), workspace: ws, selection: { file: './nope' }, seeds: [undefined] });
    expect(missing.status).toBe('error');
    expect(missing.result).toBeNull();
  }, 300_000);

  it('reports a compile error as a failed build, and refuses unsupported layouts without installing', async () => {
    mkdirSync(config.dataDir, { recursive: true });
    const { repo, sha } = await commitRepo({ 'go.mod': 'module example.com/b\n\ngo 1.22\n', 'b/b.go': 'package b\n\nfunc F() int { return missing }\n', 'b/b_test.go': 'package b\n\nimport "testing"\n\nfunc TestF(t *testing.T) { F() }\n' });
    const store = new Store(openDatabase(':memory:'));
    const inv = store.createInvestigation(freshInvestigation({ source: 'demo', repository: 't/go', commitSha: sha }));
    const ws = await new WorkspacePool({ location: repo, cacheKey: 'test:go-b' }, join(config.dataDir, 'workspaces', `go-b-${Date.now()}`), 'go').get(sha);
    const t = await runTestExperiment({ store, experiment: store.addExperiment(blankExp(inv.id, sha)), workspace: ws, selection: {}, seeds: [undefined] });
    expect(t.status).toBe('failed');
    expect(t.result!.attempts[0].tests).toBeNull();
    expect(t.result!.attempts[0].outputTail).toContain('b/b.go:3:23: undefined: missing');

    const w = await commitRepo({ 'go.mod': 'module example.com/w\n\ngo 1.22\n', 'go.work': 'go 1.22\n\nuse .\n', 'w_test.go': 'package w\n' });
    const uws = await new WorkspacePool({ location: w.repo, cacheKey: 'test:go-w' }, join(config.dataDir, 'workspaces', `go-w-${Date.now()}`), 'go').get(w.sha);
    expect(uws.unsupported).toMatch(/^Unsupported Go project layout: Go workspaces/);
    expect(uws.install).toEqual([]);
    const u = await runTestExperiment({ store, experiment: store.addExperiment(blankExp(inv.id, w.sha)), workspace: uws, selection: {}, seeds: [undefined] });
    expect(u.status).toBe('error');
    expect(u.observation).toMatch(/^Unsupported Go project layout/);
  }, 300_000);
});
