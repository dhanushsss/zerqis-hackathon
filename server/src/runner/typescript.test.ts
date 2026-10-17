import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractFacts } from '../analysis/logs.js';
import { config } from '../config.js';
import { openDatabase } from '../db/database.js';
import { newId, Store } from '../db/store.js';
import type { Experiment } from '../domain/types.js';
import { runTestExperiment, WorkspacePool } from '../pipeline/experiments.js';
import { freshInvestigation } from '../pipeline/investigate.js';
import { isTestFile } from '../pipeline/remediation.js';
import { checkDocker } from './docker.js';
import { testCommand, validateSelection } from './frameworks.js';
import { git } from './git.js';
import { parseJsonc, parseTscOutput, tsLayout } from './typescript.js';
import { checkPatchPolicy, layoutProblem } from './workspace.js';

const files = (m: Record<string, string>) => (p: string) => m[p] ?? null;
const pkg = (extra: object = {}, deps: Record<string, string> = {}) =>
  JSON.stringify({ name: 'x', private: true, devDependencies: { typescript: '5.6.3', jest: '29.7.0', 'ts-jest': '29.2.5', ...deps }, jest: { preset: 'ts-jest', testEnvironment: 'node' }, ...extra });
const TSCONFIG = '{\n  // comments and trailing commas are allowed\n  "compilerOptions": { "strict": true, },\n}\n';

describe('typescript layout policy', () => {
  it('accepts a single-package project with ts-jest, or Babel with preset-typescript', () => {
    expect(tsLayout(files({ 'package.json': pkg(), 'tsconfig.json': TSCONFIG }))).toEqual({ ok: true, checks: ['typecheck'], transform: 'ts-jest' });
    expect(tsLayout(files({ 'package.json': pkg(), 'tsconfig.json': TSCONFIG, 'tsconfig.build.json': '{}' }))).toMatchObject({ ok: true, checks: ['typecheck', 'build'] });
    const babel = JSON.stringify({ devDependencies: { typescript: '5', jest: '29', '@babel/preset-typescript': '7', '@babel/preset-env': '7' } });
    expect(tsLayout(files({ 'package.json': babel, 'tsconfig.json': '{}', 'babel.config.js': "module.exports = { presets: ['@babel/preset-env', '@babel/preset-typescript'] };" }))).toMatchObject({ ok: true, transform: 'babel' });
  });

  it.each([
    [{ 'package.json': pkg({ workspaces: ['packages/*'] }), 'tsconfig.json': '{}' }, /Monorepos are not supported \(npm\/yarn workspaces/],
    [{ 'package.json': pkg(), 'tsconfig.json': '{}', 'pnpm-workspace.yaml': 'packages: []' }, /pnpm workspaces/],
    [{ 'package.json': pkg({ type: 'module' }), 'tsconfig.json': '{}' }, /ESM-only/],
    [{ 'package.json': JSON.stringify({ devDependencies: { jest: '29', 'ts-jest': '29' }, jest: { preset: 'ts-jest' } }), 'tsconfig.json': '{}' }, /typescript is not a declared dependency/],
    [{ 'package.json': JSON.stringify({ devDependencies: { typescript: '5', vitest: '2' } }), 'tsconfig.json': '{}' }, /not run by Jest/],
    [{ 'package.json': pkg(), 'tsconfig.json': '{ "references": [{ "path": "./core" }] }' }, /Project references/],
    [{ 'package.json': pkg(), 'tsconfig.json': '{ not json' }, /could not be parsed/],
    [{ 'package.json': JSON.stringify({ devDependencies: { typescript: '5', jest: '29' } }), 'tsconfig.json': '{}' }, /not configured to compile TypeScript/],
    [{ 'package.json': pkg({ jest: undefined }), 'tsconfig.json': '{}', 'jest.config.ts': "export default { preset: 'ts-jest' };" }, /needs ts-node/],
    [{ 'package.json': pkg(), 'tsconfig.json': '{}', 'jest.config.js': '{}', 'jest.config.json': '{}' }, /More than one Jest config/],
  ])('refuses %#', (m, reason) => {
    expect(tsLayout(files(m as Record<string, string>))).toMatchObject({ ok: false, reason: expect.stringMatching(reason) });
  });

  it('reads JSONC without breaking strings that contain comment markers', () => {
    expect(parseJsonc('{ "a": "http://x/*y*/", // c\n "b": [1,2,], /* d */ }')).toEqual({ a: 'http://x/*y*/', b: [1, 2] });
  });

  it('only applies to Jest projects with a tsconfig.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alibi-ts-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ devDependencies: { jest: '29' } }));
    expect(layoutProblem('jest', dir)).toBeNull(); // plain JavaScript: unchanged behaviour
    writeFileSync(join(dir, 'tsconfig.json'), '{}');
    expect(layoutProblem('jest', dir)).toMatch(/^Unsupported TypeScript project layout: .*typescript is not a declared dependency/);
  });
});

describe('typescript checks', () => {
  it('runs tsc from node_modules with a fixed tsconfig name; checks carry no file or name', () => {
    expect(testCommand('jest', { selection: { check: 'typecheck' }, resultFile: '' })).toEqual(['node', 'node_modules/typescript/bin/tsc', '--noEmit', '--pretty', 'false', '-p', 'tsconfig.json']);
    expect(testCommand('jest', { selection: { check: 'build' }, resultFile: '' })).toEqual(['node', 'node_modules/typescript/bin/tsc', '--pretty', 'false', '-p', 'tsconfig.build.json', '--outDir', '.alibi/tsc-build']);
    expect(validateSelection('jest', { check: 'typecheck', file: 'src/a.ts', name: 'x' })).toEqual({ check: 'typecheck' });
    expect(validateSelection('maven', { check: 'typecheck' })).toEqual({});
    expect(validateSelection('jest', { check: 'rm -rf /' as never })).toEqual({});
  });

  it('parses both tsc diagnostic formats', () => {
    expect(parseTscOutput("src/cart.ts(12,7): error TS2322: Type 'string' is not assignable to type 'number'.\nsrc/x.ts:3:1 - error TS2304: Cannot find name 'y'.\nFound 2 errors.")).toEqual([
      { file: 'src/cart.ts', line: 12, code: 'TS2322', message: "Type 'string' is not assignable to type 'number'." },
      { file: 'src/x.ts', line: 3, code: 'TS2304', message: "Cannot find name 'y'." },
    ]);
  });

  it('log facts: top-level tsc errors are compile errors; ts-jest diagnostics inside a suite are not', () => {
    const tsc = extractFacts(['##[group]Run npx tsc --noEmit -p tsconfig.build.json', "src/cart.ts(12,7): error TS2322: Type 'string' is not assignable to type 'number'.", '##[error]Process completed with exit code 2.'].join('\n'), 'jest');
    expect(tsc).toMatchObject({ framework: 'jest', compileTool: 'tsc', tsBuild: true });
    expect(tsc.compileErrors).toEqual([{ file: 'src/cart.ts', line: 12, message: "TS2322: Type 'string' is not assignable to type 'number'." }]);
    expect(tsc.signature).toBe("jest: compilation error at cart.ts:12 — TS2322: Type 'string' is not assignable to type 'number'.");
    const jest = extractFacts(['FAIL src/cart.test.ts', '  ● Test suite failed to run', '', "    src/cart.ts:12:7 - error TS2322: Type 'string' is not assignable to type 'number'."].join('\n'));
    expect(jest.compileErrors).toEqual([]);
    expect(jest.failingFiles).toEqual(['src/cart.test.ts']);
  });

  it('protects TypeScript test files and blocks fixes that loosen the type check or test discovery', () => {
    expect(isTestFile('src/cart.test.ts')).toBe(true);
    expect(isTestFile('src/cart.spec.tsx')).toBe(true);
    const p = (file: string, added: string) => checkPatchPolicy(`diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1,2 @@\n x\n+${added}\n`);
    expect(p('tsconfig.json', '    "strict": false,').reasons.join()).toMatch(/TypeScript checking options/);
    expect(p('tsconfig.build.json', '  "exclude": ["src/cart.ts"],').reasons.join()).toMatch(/TypeScript checking options/);
    expect(p('package.json', '    "testPathIgnorePatterns": ["cart"],').reasons.join()).toMatch(/Jest test discovery/);
    expect(p('jest.config.js', "  globals: { 'ts-jest': { diagnostics: false } },").reasons.join()).toMatch(/Jest test discovery or TypeScript diagnostics/);
    expect(p('tsconfig.json', '    "target": "ES2022",').ok).toBe(true);
    expect(p('src/cart.ts', 'export const x: number = 1;').ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Real sandbox: npm install (network, --ignore-scripts), then tsc and ts-jest offline.

const docker = await checkDocker();

async function commitRepo(fileMap: Record<string, string>): Promise<{ repo: string; sha: string }> {
  const repo = mkdtempSync(join(tmpdir(), 'alibi-tsrepo-'));
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

describe.skipIf(!docker.ok)('typescript sandbox (requires Docker and the npm registry)', () => {
  it('type-checks and runs ts-jest tests offline after an --ignore-scripts install', async () => {
    mkdirSync(config.dataDir, { recursive: true });
    const { repo, sha } = await commitRepo({
      'package.json': pkg({}, { '@types/jest': '29.5.14' }),
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, target: 'ES2020', module: 'commonjs', esModuleInterop: true, types: ['jest'] }, include: ['src'] }),
      'src/cart.ts': "export function total(prices: number[]): number {\n  const label: number = 'sum';\n  return prices.reduce((a, b) => a + b, 0) + label;\n}\n",
      'src/cart.test.ts': "import { total } from './cart';\n\ntest('adds prices', () => {\n  expect(total([1, 2])).toBe(3);\n});\n",
    });
    const store = new Store(openDatabase(':memory:'));
    const inv = store.createInvestigation(freshInvestigation({ source: 'demo', repository: 't/ts', commitSha: sha }));
    const ws = await new WorkspacePool({ location: repo, cacheKey: 'test:ts' }, join(config.dataDir, 'workspaces', `ts-${Date.now()}`), 'jest').get(sha);
    expect(ws.unsupported).toBeUndefined();
    expect(ws.install.map((i) => i.exitCode)).toEqual([0]);

    const tc = await runTestExperiment({ store, experiment: store.addExperiment(blankExp(inv.id, sha)), workspace: ws, selection: { check: 'typecheck' }, seeds: [12345] });
    expect(tc.status).toBe('failed');
    expect(tc.command).toEqual(['node', 'node_modules/typescript/bin/tsc', '--noEmit', '--pretty', 'false', '-p', 'tsconfig.json']);
    expect(tc.result!.attempts[0]).toMatchObject({ seed: undefined, tests: null });
    expect(tc.result!.attempts[0].outputTail).toMatch(/src\/cart\.ts\(2,9\): error TS2322/);
    expect(tc.environment).toMatchObject({ network: 'none', user: '1000:1000' });

    // ts-jest reports the same type error as a failed suite.
    const jt = await runTestExperiment({ store, experiment: store.addExperiment(blankExp(inv.id, sha)), workspace: ws, selection: { file: 'src/cart.test.ts' }, seeds: [12345] });
    expect(jt.status).toBe('failed');
    expect(jt.result!.attempts[0].tests).toMatchObject({ failed: 1 });
    expect(jt.result!.attempts[0].outputTail).toMatch(/TS2322/);

    // The build config is absent here, so a build check is not run rather than reported as a failure.
    const b = await runTestExperiment({ store, experiment: store.addExperiment(blankExp(inv.id, sha)), workspace: ws, selection: { check: 'build' }, seeds: [undefined] });
    expect(b.status).toBe('error');
    expect(b.observation).toMatch(/tsconfig\.build\.json/);
  }, 600_000);
});
