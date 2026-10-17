import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { openDatabase } from '../db/database.js';
import { newId, Store } from '../db/store.js';
import { dependencyChanges } from '../analysis/diff.js';
import { extractFacts } from '../analysis/logs.js';
import { runTestExperiment, WorkspacePool } from '../pipeline/experiments.js';
import { freshInvestigation } from '../pipeline/investigate.js';
import { isTestFile, patchContextFiles, pinCandidate, quarantineCandidate } from '../pipeline/remediation.js';
import { checkDocker } from './docker.js';
import { git } from './git.js';
import { detectFramework, envFor, imageFor, installCommands, testCommand, validateSelection } from './frameworks.js';
import { parsePytestJunit, pythonLayout, requirementIssue } from './python.js';
import { checkPatchPolicy } from './workspace.js';

const files = (m: Record<string, string>) => (p: string) => m[p] ?? null;

describe('python layout policy', () => {
  it('accepts plain PyPI requirements that declare pytest', () => {
    expect(pythonLayout(files({ 'requirements.txt': 'requests==2.32.3  # http\nattrs>=23,<25\npytest==8.3.3\ntomli; python_version < "3.11"\n' }))).toEqual({ ok: true, requirementFiles: ['requirements.txt'] });
    expect(pythonLayout(files({ 'requirements.txt': 'requests\n', 'requirements-dev.txt': 'pytest\n' }))).toEqual({ ok: true, requirementFiles: ['requirements.txt', 'requirements-dev.txt'] });
  });

  it.each([
    ['-e .', /pip options are not allowed/],
    ['--index-url https://evil.example/simple', /pip options/],
    ['--extra-index-url https://x', /pip options/],
    ['-r other.txt', /pip options/],
    ['git+https://github.com/x/y.git', /URL, VCS/],
    ['pkg @ https://example.com/pkg.whl', /URL, VCS/],
    ['./vendor/pkg', /URL, VCS/],
    ['pkg==1.0 --hash=sha256:abc', /URL, VCS|not a recognizable/],
    ['pkg==1.0 \\', /continuations/],
  ])('rejects %s', (line, why) => {
    expect(requirementIssue(line)).toMatch(why);
    const layout = pythonLayout(files({ 'requirements.txt': `pytest==8.3.3\n${line}\n` }));
    expect(layout.ok).toBe(false);
    if (!layout.ok) expect(layout.reason).toMatch(/^requirements\.txt line 2: /);
  });

  it.each([
    [{ Pipfile: '[packages]' }, /Pipenv/],
    [{ 'pyproject.toml': '[tool.poetry]\nname = "x"' }, /Poetry/],
    [{ 'poetry.lock': '' }, /Poetry/],
    [{ 'uv.lock': '' }, /uv/],
    [{ 'pyproject.toml': '[project]\nname = "x"\ndependencies = ["pytest"]' }, /pyproject\.toml \[project\] dependencies/],
    [{ 'setup.py': 'from setuptools import setup' }, /setup\.py/],
    [{}, /No requirements file was found/],
    [{ 'requirements.txt': 'requests==2.32.3\n' }, /pytest is not declared/],
  ])('reports unsupported layout %j explicitly', (layout, why) => {
    const r = pythonLayout(files(layout as Record<string, string>));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(why);
      expect(r.reason).toMatch(/Supported: PyPI requirements/);
    }
  });

  it('detects conventional pytest repositories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alibi-py-'));
    expect(detectFramework(dir)).toBe('unknown');
    writeFileSync(join(dir, 'requirements.txt'), 'pytest==8.3.3\n');
    expect(detectFramework(dir)).toBe('pytest');
    for (const [file, text] of [['pyproject.toml', '[tool.poetry.group.dev.dependencies]\npytest = "8.3.3"\n'], ['pyproject.toml', '[project]\ndependencies = ["pytest>=8"]\n'], ['Pipfile', '[dev-packages]\npytest = "*"\n']]) {
      const d = mkdtempSync(join(tmpdir(), 'alibi-py-'));
      writeFileSync(join(d, file), text);
      expect(detectFramework(d), text).toBe('pytest');
    }
    const plain = mkdtempSync(join(tmpdir(), 'alibi-py-'));
    writeFileSync(join(plain, 'pyproject.toml'), '[project]\nname = "pytest-like-name"\ndependencies = ["requests"]\n');
    expect(detectFramework(plain)).toBe('unknown');
    writeFileSync(join(dir, 'pom.xml'), '<project/>');
    expect(detectFramework(dir)).toBe('maven');
  });
});

describe('pytest commands', () => {
  it('installs into a workspace venv, wheels only, from PyPI, in isolated mode', () => {
    const [venv, pip] = installCommands('pytest', false, undefined, ['requirements.txt', 'requirements-dev.txt']);
    expect(venv).toEqual(['python', '-I', '-m', 'venv', '/work/.alibi/venv']);
    expect(pip.slice(0, 4)).toEqual(['/work/.alibi/venv/bin/python', '-I', '-m', 'pip']);
    for (const flag of ['--only-binary=:all:', '--no-input']) expect(pip).toContain(flag);
    expect(pip.join(' ')).toContain('--index-url https://pypi.org/simple');
    expect(pip.slice(-4)).toEqual(['-r', 'requirements.txt', '-r', 'requirements-dev.txt']);
    expect(envFor('pytest').PIP_CONFIG_FILE).toBe('/dev/null');
    expect(imageFor('pytest')).toMatch(/^python:3\.12\.\d+-slim-bookworm@sha256:[0-9a-f]{64}$/);
  });

  it('runs one validated node id after "--", never through a shell', () => {
    const cmd = testCommand('pytest', { selection: { file: 'tests/test_a.py', name: 'TestK::test_p[a b]' }, resultFile: '/work/.alibi/r.xml' });
    expect(cmd.slice(0, 3)).toEqual(['/work/.alibi/venv/bin/python', '-m', 'pytest']);
    expect(cmd).toContain('--junitxml=/work/.alibi/r.xml');
    expect(cmd.slice(-2)).toEqual(['--', 'tests/test_a.py::TestK::test_p[a b]']);
    expect(testCommand('pytest', { selection: {}, resultFile: '/r.xml' })).not.toContain('--');
  });

  it.each([
    [{ file: '--co', name: 'x' }, {}],
    [{ file: '../x.py' }, {}],
    [{ file: 'tests/-k.py' }, {}],
    [{ file: 'tests/test_a.js' }, {}],
    [{ file: 'tests/test_a.py', name: 'test_x; rm -rf /' }, { file: 'tests/test_a.py' }],
    [{ file: 'tests/test_a.py', name: '-k not slow' }, { file: 'tests/test_a.py' }],
    [{ name: 'test_x' }, {}],
    [{ file: 'tests/test_a.py', name: 'TestK::test_p[1-2]' }, { file: 'tests/test_a.py', name: 'TestK::test_p[1-2]' }],
  ])('validates selection %j', (sel, expected) => {
    expect(validateSelection('pytest', sel)).toEqual(expected);
  });
});

describe('pytest results', () => {
  it('parses JUnit XML into node ids, counting collection errors and ignoring skips', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alibi-junit-'));
    const file = join(dir, 'r.xml');
    writeFileSync(file, `<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest" errors="1" failures="2" skipped="1" tests="5">
<testcase classname="tests.test_a.TestK" name="test_p[2]" file="tests/test_a.py" line="4"><failure message="assert 2 == 1">E   assert 2 == 1</failure></testcase>
<testcase classname="tests.test_a" name="test_bad" file="tests/test_a.py" line="2"><failure message="AssertionError: math&#10;assert (1 + 1) == 3">E</failure></testcase>
<testcase classname="tests.test_a" name="test_ok" file="tests/test_a.py" line="1" time="0.0" />
<testcase classname="tests.test_a" name="test_skip" file="tests/test_a.py" line="9"><skipped message="x"/></testcase>
<testcase classname="" name="tests.test_b" file="tests/test_b.py"><error message="collection failure">E</error></testcase>
</testsuite></testsuites>`);
    expect(parsePytestJunit(file)).toEqual({
      total: 4,
      passed: 1,
      failed: 3,
      failedNames: ['tests/test_a.py::TestK::test_p[2]', 'tests/test_a.py::test_bad', 'tests/test_b.py: collection error'],
    });
    expect(parsePytestJunit(join(dir, 'missing.xml'))).toBeNull();
    writeFileSync(file, 'not xml');
    expect(parsePytestJunit(file)).toBeNull();
  });

  it('extracts failing node ids, assertion, and summary from a pytest CI log', () => {
    const log = [
      '2026-10-16T10:00:00.0000000Z ============================= test session starts ==============================',
      'collected 4 items',
      'tests/test_ship.py F.F.                                                    [100%]',
      '=================================== FAILURES ===================================',
      '_____________________________ test_small_parcel _______________________________',
      'tests/test_ship.py:7: in test_small_parcel',
      '    assert shipping_cents(1.0) == 499',
      'E   assert 899 == 499',
      'E    +  where 899 = shipping_cents(1.0)',
      '=========================== short test summary info ============================',
      'FAILED tests/test_ship.py::test_small_parcel - assert 899 == 499',
      'FAILED tests/test_ship.py::TestRates::test_large[20] - assert 1999 == 2999',
      '========================= 2 failed, 2 passed in 0.04s ==========================',
      '##[error]Process completed with exit code 1.',
    ].join('\n');
    const f = extractFacts(log);
    expect(f.framework).toBe('pytest');
    expect(f.failingTests).toEqual([
      { name: 'test_small_parcel', file: 'tests/test_ship.py' },
      { name: 'TestRates::test_large[20]', file: 'tests/test_ship.py' },
    ]);
    expect(f.failingFiles).toEqual(['tests/test_ship.py']);
    expect(f.assertion).toBe('assert 899 == 499 | +  where 899 = shipping_cents(1.0)');
    expect(f.testSummary).toBe('2 failed, 2 passed in 0.04s');
    expect(f.exitCode).toBe(1);
    expect(f.signature).toBe('pytest: tests/test_ship.py › test_small_parcel (+1 more) — assert 899 == 499');
  });

  it('records collection errors as failing files', () => {
    const f = extractFacts('ERROR tests/test_b.py - ModuleNotFoundError: No module named \'nope\'\n1 error in 0.09s', 'pytest');
    expect(f.failingFiles).toEqual(['tests/test_b.py']);
    expect(f.failingTests).toEqual([]);
    expect(f.assertion).toBe("ModuleNotFoundError: No module named 'nope'");
  });
});

describe('python remediation', () => {
  it('treats pytest tests and configuration as test files', () => {
    for (const p of ['tests/test_a.py', 'test_a.py', 'pkg/a_test.py', 'conftest.py', 'pkg/conftest.py', 'pytest.ini']) expect(isTestFile(p)).toBe(true);
    for (const p of ['src/shipping.py', 'testing_utils.py', 'requirements.txt']) expect(isTestFile(p)).toBe(false);
  });

  it('offers requirements files, but not docs or tests, as patch context', () => {
    const diff = { files: ['requirements.txt', 'README.md', 'notes.txt', 'tests/test_a.py', 'src/a.py'].map((path) => ({ path, additions: 1, deletions: 1 })), diff: '', truncated: false, dependencyChanges: [], onlyDocs: false };
    const facts = extractFacts('');
    expect(patchContextFiles(facts, diff)).toEqual(['requirements.txt', 'src/a.py']);
  });

  it('detects a pinned requirement change and pins it back', () => {
    const diff = 'diff --git a/requirements.txt b/requirements.txt\n--- a/requirements.txt\n+++ b/requirements.txt\n@@ -1,2 +1,2 @@\n-Requests==2.31.0\n+requests==2.32.3\n pytest==8.3.3\n';
    const changes = dependencyChanges(diff);
    expect(changes).toEqual([{ ecosystem: 'pypi', name: 'requests', from: '2.31.0', to: '2.32.3', file: 'requirements.txt', removedLine: 'Requests==2.31.0', addedLine: 'requests==2.32.3' }]);
    const pin = pinCandidate({ files: [], diff, truncated: false, dependencyChanges: changes, onlyDocs: false }, () => 'requests==2.32.3\npytest==8.3.3\n');
    expect(pin?.edits[0].content).toBe('Requests==2.31.0\npytest==8.3.3\n');
  });

  it('quarantines a pytest test with a skip marker and imports pytest when needed', () => {
    const content = '"""Retry queue tests."""\nfrom __future__ import annotations\nfrom queue import RetryQueue\n\n\nclass TestQueue:\n    @staticmethod\n    def test_jitter():\n        assert RetryQueue().delay() < 1\n';
    const q = quarantineCandidate({ testFile: 'tests/test_queue.py', testFullName: 'TestQueue::test_jitter', content, investigationId: 'inv_1', failureSummary: 'failed 2/10 runs' });
    expect(q?.strategy).toBe('quarantine');
    expect(q?.edits[0].content).toBe(
      '"""Retry queue tests."""\nfrom __future__ import annotations\nimport pytest\nfrom queue import RetryQueue\n\n\nclass TestQueue:\n    # Re-enable once the nondeterminism is removed.\n    @pytest.mark.skip(reason="Quarantined by Zerqis (investigation inv_1): failed 2/10 runs")\n    @staticmethod\n    def test_jitter():\n        assert RetryQueue().delay() < 1\n',
    );
    expect(quarantineCandidate({ testFile: 'tests/test_queue.py', testFullName: 'test_missing', content, investigationId: 'i', failureSummary: 's' })).toBeNull();
  });
});

describe('python patch policy', () => {
  const patch = (file: string, added: string) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old\n+${added}\n`;

  it('allows a PyPI version change', () => {
    expect(checkPatchPolicy(patch('requirements.txt', 'requests==2.31.0')).ok).toBe(true);
  });

  it.each([
    [patch('requirements.txt', '--extra-index-url https://evil.example/simple'), /PyPI package versions/],
    [patch('requirements-dev.txt', 'evil @ https://evil.example/e.whl'), /PyPI package versions/],
    [patch('requirements.txt', '-e .'), /PyPI package versions/],
    [patch('pip.conf', '[global]'), /not allowed/],
    [patch('pyproject.toml', 'addopts = "--deselect tests/test_a.py::test_x"'), /pytest collection/],
    [patch('setup.cfg', 'python_files = nothing_*.py'), /pytest collection/],
  ])('rejects %#', (diff, why) => {
    const r = checkPatchPolicy(diff);
    expect(r.ok).toBe(false);
    expect(r.reasons.join('; ')).toMatch(why);
  });
});

async function commitRepo(fileMap: Record<string, string>): Promise<{ repo: string; sha: string }> {
  const repo = mkdtempSync(join(tmpdir(), 'alibi-pyrepo-'));
  for (const [path, content] of Object.entries(fileMap)) {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  await git(['init', '-q', '-b', 'main'], { cwd: repo });
  await git(['add', '-A'], { cwd: repo });
  await git(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init'], { cwd: repo });
  return { repo, sha: (await git(['rev-parse', 'HEAD'], { cwd: repo })).trim() };
}

const docker = await checkDocker();
describe.skipIf(!docker.ok)('pytest sandbox (requires Docker and PyPI)', () => {
  it('installs pinned requirements, runs a node id offline, and parses the structured result', async () => {
    mkdirSync(config.dataDir, { recursive: true });
    const { repo, sha } = await commitRepo({
      'requirements.txt': 'pytest==8.3.3\n',
      'calc/__init__.py': '',
      'calc/ops.py': 'def add(a, b):\n    return a - b\n',
      'tests/test_ops.py': 'from calc.ops import add\n\n\ndef test_add():\n    assert add(2, 2) == 4\n\n\ndef test_zero():\n    assert add(0, 0) == 0\n',
    });
    const store = new Store(openDatabase(':memory:'));
    const inv = store.createInvestigation(freshInvestigation({ source: 'demo', repository: 't/py', commitSha: sha }));
    const pool = new WorkspacePool({ location: repo, cacheKey: 'test:pytest' }, join(config.dataDir, 'workspaces', `pytest-${Date.now()}`), 'pytest');
    const ws = await pool.get(sha);
    expect(ws.unsupported).toBeUndefined();
    expect(ws.install.map((i) => i.exitCode)).toEqual([0, 0]);
    const exp = store.addExperiment({ id: newId('exp'), investigationId: inv.id, hypothesisKey: null, kind: 'reproduce', title: 'reproduce', reason: '', status: 'queued', backend: 'docker', command: null, environment: null, commitSha: sha, testSelection: null, plannedAttempts: 1, startedAt: null, finishedAt: null, durationMs: null, result: null, observation: null, effect: null, patchId: null });
    const r = await runTestExperiment({ store, experiment: exp, workspace: ws, selection: { file: 'tests/test_ops.py', name: 'test_add' }, seeds: [undefined] });
    expect(r.status).toBe('failed');
    expect(r.command?.slice(-2)).toEqual(['--', 'tests/test_ops.py::test_add']);
    expect(r.result!.attempts[0]).toMatchObject({ exitCode: 1, tests: { total: 1, passed: 0, failed: 1, failedNames: ['tests/test_ops.py::test_add'] } });
    expect(r.result!.attempts[0].outputTail).toMatch(/E\s+assert 0 == 4/);
    expect(r.environment).toMatchObject({ image: config.runner.pythonImage, network: 'none', user: '1000:1000' });

    // A candidate that makes requirements fetch from a VCS URL never reaches pip.
    const vcs = 'diff --git a/requirements.txt b/requirements.txt\n--- a/requirements.txt\n+++ b/requirements.txt\n@@ -1 +1,2 @@\n pytest==8.3.3\n+evil @ git+https://example.invalid/evil.git\n';
    const blocked = await pool.fresh(sha, 'vcs', vcs);
    expect(blocked.patchApplied?.ok).toBe(false);
    expect(blocked.patchApplied?.detail).toMatch(/PyPI package versions/);
    expect(blocked.install).toEqual([]);
  }, 300_000);

  it('refuses an unsupported layout without installing or running anything', async () => {
    mkdirSync(config.dataDir, { recursive: true });
    const { repo, sha } = await commitRepo({ 'pyproject.toml': '[tool.poetry]\nname = "x"\n', 'tests/test_a.py': 'def test_a():\n    assert True\n' });
    const store = new Store(openDatabase(':memory:'));
    const inv = store.createInvestigation(freshInvestigation({ source: 'demo', repository: 't/py', commitSha: sha }));
    const ws = await new WorkspacePool({ location: repo, cacheKey: 'test:pytest-poetry' }, join(config.dataDir, 'workspaces', `pytest-u-${Date.now()}`), 'pytest').get(sha);
    expect(ws.unsupported).toMatch(/Poetry/);
    expect(ws.install).toEqual([]);
    const exp = store.addExperiment({ id: newId('exp'), investigationId: inv.id, hypothesisKey: null, kind: 'reproduce', title: 'reproduce', reason: '', status: 'queued', backend: 'docker', command: null, environment: null, commitSha: sha, testSelection: null, plannedAttempts: 1, startedAt: null, finishedAt: null, durationMs: null, result: null, observation: null, effect: null, patchId: null });
    const r = await runTestExperiment({ store, experiment: exp, workspace: ws, selection: {}, seeds: [undefined] });
    expect(r.status).toBe('error');
    expect(r.observation).toMatch(/^Unsupported Python project layout: Dependencies are declared with Poetry/);
    expect(r.result).toBeNull();
  });
});
