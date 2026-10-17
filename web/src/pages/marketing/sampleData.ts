import type { Bundle, Experiment, Patch } from '../../api';

/**
 * Read-only view of recorded sample investigations for the marketing pages.
 * Everything shown comes from the stored bundles in src/test-fixtures (real runs
 * against the bundled sample repositories). Nothing here starts an investigation
 * or calls a provider; values are selected, never invented.
 */
export type SampleId = 'code-regression' | 'maven-dependency' | 'flaky-jest';

export interface SampleExperiment {
  id: string;
  kind: Experiment['kind'];
  title: string;
  commit: 'failing' | 'parent';
  sha: string;
  attempts: boolean[];
  failures: number;
  observation: string;
  effect: string;
  output: string;
}

/** One recorded sandbox run used to validate a candidate fix. */
export interface SampleRun {
  /** Number of executions (attempts) and how many of them failed. */
  runs: number;
  failedRuns: number;
  durationMs: number;
  /** Test counts reported by the framework for the last attempt, when it reported them. */
  tests: { total: number; passed: number; failed: number } | null;
  selection: string;
  /** Framework output of the last attempt, without ANSI codes or internal file paths. */
  output: string;
}

export interface SamplePatch {
  id: string;
  title: string;
  strategy: Patch['strategy'];
  origin: Patch['origin'];
  status: Patch['status'];
  summary: string;
  diff: string;
  /** The candidate's targeted runs of the originally failing test(s). */
  targeted: SampleRun | null;
  /** The full suite run with the candidate applied; null when the targeted run already covered the whole build. */
  suite: SampleRun | null;
  environment: { image: string; network: string; installNetwork: string | null } | null;
}

export interface Sample {
  id: SampleId;
  /** Sample repository name without the fixture owner prefix. */
  repo: string;
  framework: string;
  branch: string | null;
  commitMessage: string | null;
  workflow: string | null;
  sha: string;
  parentSha: string | null;
  recordedAt: string;
  signature: string;
  summary: string;
  verdict: string;
  classification: string;
  confidence: string;
  basis: string[];
  hypotheses: Array<{ key: string; cause: string; status: string }>;
  experiments: SampleExperiment[];
  patches: SamplePatch[];
  /** Observed facts and diff findings recorded before any experiment ran. */
  facts: string[];
  ledger: Array<{ seq: number; kind: string; title: string; provenance: string }>;
}

const loaders: Record<SampleId, () => Promise<{ default: unknown }>> = {
  'code-regression': () => import('../../test-fixtures/code-regression.json'),
  'maven-dependency': () => import('../../test-fixtures/maven-dependency.json'),
  'flaky-jest': () => import('../../test-fixtures/flaky-jest.json'),
};

/** Readable test output: ANSI codes and internal result-file lines removed. */
export function cleanOutput(text: string | null | undefined): string {
  return (text ?? '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split('\n')
    .filter((l) => !/^Test results written to/.test(l))
    .join('\n')
    .trim();
}

function toRun(e: Experiment | null): SampleRun | null {
  if (!e?.result) return null;
  const last = e.result.attempts[e.result.attempts.length - 1];
  return {
    runs: e.result.attempts.length,
    failedRuns: e.result.failures,
    durationMs: e.durationMs ?? e.result.attempts.reduce((n, a) => n + a.durationMs, 0),
    tests: last?.tests ? { total: last.tests.total, passed: last.tests.passed, failed: last.tests.failed } : null,
    selection: e.testSelection ?? '',
    output: cleanOutput(last?.outputTail),
  };
}

export function toSample(id: SampleId, b: Bundle): Sample {
  const inv = b.investigation;
  const experiments = b.experiments
    .filter((e) => e.backend === 'docker' && !e.patchId && e.result && e.kind !== 'validate_patch' && e.kind !== 'regression_suite')
    .map((e) => ({
      id: e.id,
      kind: e.kind,
      title: e.title,
      commit: e.commitSha === inv.parentSha ? ('parent' as const) : ('failing' as const),
      sha: e.commitSha ?? '',
      attempts: e.result!.attempts.map((a) => a.passed),
      failures: e.result!.failures,
      observation: e.observation ?? '',
      effect: e.effect ?? '',
      output: cleanOutput(e.result!.attempts[e.result!.attempts.length - 1]?.outputTail),
    }));
  return {
    id,
    repo: inv.repository.split('/').pop() ?? inv.repository,
    framework: inv.framework,
    branch: inv.branch ?? null,
    commitMessage: inv.commitMessage ?? null,
    workflow: inv.workflow ?? null,
    sha: inv.commitSha,
    parentSha: inv.parentSha,
    recordedAt: inv.createdAt,
    signature: inv.failureSignature ?? '',
    summary: inv.summary ?? '',
    verdict: inv.verdict ?? 'inconclusive',
    classification: inv.classification ?? 'unknown',
    confidence: inv.confidence?.label ?? '',
    basis: inv.confidence?.basis ?? [],
    hypotheses: [...b.hypotheses].sort((a, c) => a.rank - c.rank).map((h) => ({ key: h.key, cause: h.cause, status: h.status })),
    experiments,
    patches: b.patches.map((p) => {
      const targeted = b.experiments.find((e) => e.id === p.validation?.targetedExperimentId) ?? null;
      const suiteExp = b.experiments.find((e) => e.id === p.validation?.suiteExperimentId) ?? null;
      const env = (targeted?.environment ?? null) as { image?: string; network?: string; dependencyInstall?: Array<{ network?: string }> } | null;
      return {
        id: p.id,
        title: p.title,
        strategy: p.strategy,
        origin: p.origin,
        status: p.status,
        summary: p.validation?.summary ?? '',
        diff: p.diff,
        targeted: toRun(targeted),
        // Some frameworks validate with one full build; the same experiment then stands for both.
        suite: suiteExp && suiteExp.id !== targeted?.id ? toRun(suiteExp) : null,
        environment: env ? { image: env.image ?? '', network: env.network ?? '', installNetwork: env.dependencyInstall?.[0]?.network ?? null } : null,
      };
    }),
    facts: b.evidence.filter((e) => e.kind === 'observed_fact' && (e.provenance.type === 'git' || e.provenance.type === 'log')).map((e) => e.title),
    // External search results are excluded: they are leads, and the recorded queries are not product copy.
    ledger: b.evidence
      .filter((e) => e.kind !== 'external_source')
      .map((e) => ({ seq: e.seq, kind: e.kind, title: e.title, provenance: e.provenance.type })),
  };
}

const cache = new Map<SampleId, Promise<Sample>>();

export function loadSample(id: SampleId): Promise<Sample> {
  let p = cache.get(id);
  if (!p) {
    p = loaders[id]().then((m) => toSample(id, m.default as Bundle));
    cache.set(id, p);
  }
  return p;
}

export function shortSha(sha: string | null | undefined): string {
  return (sha ?? '').slice(0, 7);
}

export function recordedDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

const FRAMEWORK_LABEL: Record<string, string> = { jest: 'Jest', maven: 'Maven', pytest: 'pytest' };

export function frameworkLabel(f: string): string {
  return FRAMEWORK_LABEL[f] ?? f;
}
