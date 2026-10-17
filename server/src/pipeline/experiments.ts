import { join } from 'node:path';
import { config } from '../config.js';
import { redactSecrets } from '../analysis/redact.js';
import { wilson } from '../analysis/stats.js';
import type { Store } from '../db/store.js';
import type { Attempt, Experiment, Framework, TestCounts } from '../domain/types.js';
import { runContainer } from '../runner/docker.js';
import { envFor, imageFor, parseJestResult, parseSurefireReports, testCommand, type TestSelection } from '../runner/frameworks.js';
import { prepareWorkspace, type RepoSource, type Workspace } from '../runner/workspace.js';

/** Fixed, spread-out seed sequence so every repeated Jest run is replayable. */
export function attemptSeed(index: number): number {
  return index * 65537;
}

export function describeSelection(framework: Framework, sel: TestSelection): string {
  if (!sel.file && !sel.name) return framework === 'maven' ? 'full build and test suite' : 'full test suite';
  if (framework === 'maven') return sel.name ? `${sel.file}#${sel.name}` : `${sel.file}`;
  return sel.name ? `${sel.file ?? ''} › ${sel.name}` : `${sel.file}`;
}

export class WorkspacePool {
  private cache = new Map<string, Promise<Workspace>>();
  constructor(
    private readonly source: RepoSource,
    private readonly root: string,
    private readonly framework: Framework,
  ) {}

  /** One prepared (installed) workspace per commit, reused across experiments. */
  get(sha: string): Promise<Workspace> {
    let ws = this.cache.get(sha);
    if (!ws) {
      ws = prepareWorkspace(this.source, sha, join(this.root, sha.slice(0, 12)), this.framework);
      this.cache.set(sha, ws);
    }
    return ws;
  }

  /** A fresh, single-use workspace (used for applying candidate patches). */
  fresh(sha: string, label: string): Promise<Workspace> {
    return prepareWorkspace(this.source, sha, join(this.root, `${label}-${sha.slice(0, 8)}`), this.framework);
  }
}

function installFailure(ws: Workspace): string | null {
  // npm install failures are fatal; Maven warm-up may fail when the commit doesn't compile (expected).
  if (ws.framework === 'jest') {
    const bad = ws.install.find((i) => i.exitCode !== 0);
    if (bad) return `Dependency installation failed (exit ${bad.exitCode ?? 'timeout'}):\n${bad.output.slice(-3000)}`;
  }
  return null;
}

export interface RunTestsOptions {
  store: Store;
  experiment: Experiment;
  workspace: Workspace;
  selection: TestSelection;
  seeds: Array<number | undefined>;
}

/** Executes the attempts of a test experiment, persisting progress after each attempt. */
export async function runTestExperiment(opts: RunTestsOptions): Promise<Experiment> {
  const { store, workspace: ws, selection } = opts;
  const startedAt = new Date();
  let exp = store.updateExperiment(opts.experiment.id, { status: 'running', startedAt: startedAt.toISOString() });

  const installErr = installFailure(ws);
  if (installErr) {
    return store.updateExperiment(exp.id, {
      status: 'error',
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      observation: redactSecrets(installErr).text,
    });
  }

  const attempts: Attempt[] = [];
  let lastCommand: string[] = [];
  for (let i = 0; i < opts.seeds.length; i++) {
    const seed = ws.framework === 'jest' ? opts.seeds[i] : undefined;
    const resultFile = `/work/.alibi/result-${exp.id}-${i + 1}.json`;
    const command = testCommand(ws.framework, { selection, seed, resultFile });
    lastCommand = command;
    const res = await runContainer({
      image: imageFor(ws.framework),
      command,
      workspace: ws.dir,
      cacheDir: ws.cacheDir,
      network: false,
      env: envFor(ws.framework),
      timeoutSec: config.runner.timeoutSec,
    });
    let tests: TestCounts | null =
      ws.framework === 'maven' ? parseSurefireReports(ws.dir) : parseJestResult(join(ws.dir, '.alibi', `result-${exp.id}-${i + 1}.json`));
    if (ws.framework === 'maven' && /COMPILATION ERROR|Compilation failure/.test(res.output)) tests = null;
    attempts.push({
      index: i + 1,
      exitCode: res.exitCode,
      passed: res.exitCode === 0,
      timedOut: res.timedOut,
      durationMs: res.durationMs,
      seed,
      tests,
      outputTail: redactSecrets(res.output.slice(-6000)).text,
    });
    const failures = attempts.filter((a) => !a.passed).length;
    exp = store.updateExperiment(exp.id, {
      command,
      result: { attempts, passes: attempts.length - failures, failures },
    });
  }

  const failures = attempts.filter((a) => !a.passed).length;
  const result = {
    attempts,
    passes: attempts.length - failures,
    failures,
    failureRate: attempts.length > 1 ? wilson(failures, attempts.length) : undefined,
  };
  return store.updateExperiment(exp.id, {
    status: failures > 0 ? 'failed' : 'passed',
    command: lastCommand,
    result,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    environment: {
      backend: 'docker',
      image: imageFor(ws.framework),
      network: 'none',
      user: '1000:1000',
      cpus: config.runner.cpus,
      memory: config.runner.memory,
      readOnlyRoot: true,
      capabilities: 'all dropped',
      timeoutSec: config.runner.timeoutSec,
      dependencyInstall: ws.install.map((i) => ({ exitCode: i.exitCode, durationMs: i.durationMs, network: 'bridge (install only)' })),
    },
  });
}

export function summarizeAttempts(exp: Experiment): string {
  const r = exp.result;
  if (!r) return 'No result.';
  const n = r.attempts.length;
  const failedNames = [...new Set(r.attempts.flatMap((a) => a.tests?.failedNames ?? []))];
  const compileFail = r.attempts.some((a) => !a.passed && !a.tests);
  const parts = [`${r.failures}/${n} ${n === 1 ? 'run' : 'runs'} failed`];
  if (compileFail) parts.push('(build failed before tests ran)');
  if (failedNames.length) parts.push(`— failing: ${failedNames.slice(0, 3).join('; ')}`);
  if (r.failureRate) parts.push(`(observed failure rate ${Math.round(r.failureRate.rate * 100)}%, 95% CI ${Math.round(r.failureRate.low * 100)}–${Math.round(r.failureRate.high * 100)}%)`);
  return parts.join(' ');
}
