import { existsSync, mkdirSync } from 'node:fs';
import type { CommitDiff } from '../analysis/diff.js';
import type { ChangeOutcome, Classification, Experiment, Patch, TestCounts, Verdict } from '../domain/types.js';
import { git, gitOk } from '../runner/git.js';
import { fixOutcome } from './agentLoop.js';
import { isTestFile } from './remediation.js';

/**
 * Change verification: deterministic rules that turn the experiments run on a
 * base/head revision pair into an outcome. Models never decide the outcome;
 * they only take part through the ordinary investigation stages.
 */

export const REVISION = /^[0-9a-f]{7,40}$/;
export const GITHUB_REPO_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?\/?$/;

/** Normalizes a public GitHub repository URL, or returns null. */
export function parseRepoUrl(url: string): { owner: string; repo: string; url: string } | null {
  const m = GITHUB_REPO_URL.exec(url.trim());
  if (!m || m[1].startsWith('.') || m[2].startsWith('.')) return null;
  return { owner: m[1], repo: m[2], url: `https://github.com/${m[1]}/${m[2]}` };
}

/** Full SHA of a commit present in `repoDir`, or null. Only hex revisions are accepted. */
export async function resolveRevision(repoDir: string, rev: string): Promise<string | null> {
  if (!REVISION.test(rev)) return null;
  const r = await gitOk(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { cwd: repoDir });
  const sha = r.ok ? r.stdout.trim() : '';
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/**
 * Keeps a local mirror of a public GitHub repository for diffs and reverts. Revisions not in the
 * default clone (e.g. pull-request heads) are fetched by SHA. Hooks stay disabled (see git.ts).
 */
export async function syncRemoteRepo(url: string, dir: string, revisions: string[]): Promise<void> {
  if (!parseRepoUrl(url)) throw new Error(`Refusing to clone ${url}`);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    await git(['clone', '--quiet', '--no-checkout', '--no-recurse-submodules', url, dir], { cwd: dir, timeoutMs: 300_000 });
  } else {
    await gitOk(['fetch', '--quiet', 'origin'], { cwd: dir, timeoutMs: 300_000 });
  }
  for (const rev of revisions) {
    if (!REVISION.test(rev) || (await resolveRevision(dir, rev))) continue;
    // Only full SHAs can be fetched directly; abbreviated ones must already be in the clone.
    if (rev.length === 40) await gitOk(['fetch', '--quiet', '--depth=1', 'origin', rev], { cwd: dir, timeoutMs: 300_000 });
  }
}

const TEST_DECL_OR_ASSERT = /\b(test|it|describe)\s*\(|\bdef test_|@Test\b|\bexpect\s*\(|\bassert/;
const SKIP_MARKER = /\.(skip|only|todo)\s*\(|\bx(it|test|describe)\s*\(|@pytest\.mark\.(skip|xfail)|\bpytest\.skip\(|@Disabled\b|@Ignore\b/;

/**
 * Ways a change can make tests pass without the behaviour being right: editing or removing
 * existing tests and assertions, or skipping them. Additions of new tests are not a concern.
 */
export function testScopeConcerns(diff: CommitDiff | null): string[] {
  if (!diff) return [];
  const out: string[] = [];
  for (const chunk of diff.diff.split(/^diff --git /m).slice(1)) {
    const file = /^a\/(\S+)/.exec(chunk)?.[1] ?? '';
    if (!isTestFile(file)) continue;
    const lines = chunk.split('\n');
    const removed = lines.filter((l) => l.startsWith('-') && !l.startsWith('---'));
    const added = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++'));
    if (added.some((l) => SKIP_MARKER.test(l))) out.push(`The change adds a skip or focus marker in ${file}.`);
    if (removed.some((l) => TEST_DECL_OR_ASSERT.test(l))) out.push(`The change modifies or removes existing tests or assertions in ${file}.`);
  }
  if (diff.truncated) out.push('The diff exceeded the analysis limit, so test edits beyond it were not checked.');
  return out;
}

export interface SuiteRun {
  status: Experiment['status'];
  tests: TestCounts | null;
  observation?: string | null;
}

/** Outcome when the full suite passed at the changed revision. */
export function decidePassingChange(head: SuiteRun, base: SuiteRun, concerns: string[]): { outcome: ChangeOutcome; detail: string } {
  const n = head.tests?.total ?? 0;
  if (!head.tests || n === 0) {
    return { outcome: 'inconclusive', detail: 'The test command succeeded at the changed revision but no test results were recorded, so there is no evidence about the change.' };
  }
  if (base.status === 'error' || base.status === 'skipped') {
    return { outcome: 'inconclusive', detail: `All ${n} tests passed at the changed revision, but the base revision could not be tested, so the test scope of the two revisions cannot be compared.` };
  }
  if (base.tests && n < base.tests.total) {
    return { outcome: 'inconclusive', detail: `All ${n} tests passed at the changed revision, but the base revision ran ${base.tests.total}: the change reduced the tested scope, so passing tests are not evidence that behaviour was preserved.` };
  }
  if (concerns.length) {
    return { outcome: 'inconclusive', detail: `All ${n} tests passed at the changed revision, but ${concerns.join(' ')} Passing tests may reflect changed expectations rather than preserved behaviour.` };
  }
  const baseNote = base.tests ? (base.tests.failed ? ` The base revision failed ${base.tests.failed} of ${base.tests.total}.` : ` The base revision also passed all ${base.tests.total}.`) : '';
  return {
    outcome: 'no_regression_observed',
    detail: `All ${n} tests that ran at the changed revision passed.${baseNote} This covers only behaviour those tests exercise; it is not proof that the change is correct.`,
  };
}

/** Outcome after the full investigation of a change whose suite failed at the changed revision. */
export function decideFailingChange(args: {
  verdict: Verdict | null;
  classification: Classification | null;
  sandboxRan: boolean;
  experiments: Experiment[];
  baseSuiteId: string;
  headSha: string;
  baseSha: string;
}): { outcome: ChangeOutcome; detail: string } {
  const { experiments } = args;
  if (!args.sandboxRan) return { outcome: 'blocked', detail: 'No sandbox experiment produced a result, so the change could not be tested.' };
  const reproduced = experiments.filter((e) => e.kind === 'reproduce' && e.commitSha === args.headSha && e.result);
  const compared = experiments.filter((e) => e.kind === 'compare_parent' && e.commitSha === args.baseSha && e.result && e.id !== args.baseSuiteId);
  const baseSuite = experiments.find((e) => e.id === args.baseSuiteId);
  const comparisons = compared.length ? compared : baseSuite?.result ? [baseSuite] : [];
  const failingAtHead = reproduced.some((e) => e.result!.failures > 0);
  if (!comparisons.length) {
    return { outcome: 'inconclusive', detail: `Tests fail at the changed revision ${args.headSha.slice(0, 12)}, but the base revision could not be tested, so the failure cannot be attributed to the change.` };
  }
  const basePasses = comparisons.every((e) => e.result!.failures === 0);
  const regressionClass = args.classification === 'code_regression' || args.classification === 'dependency_regression';
  if (failingAtHead && basePasses && regressionClass && (args.verdict === 'confirmed' || args.verdict === 'probable')) {
    const names = [...new Set(reproduced.flatMap((e) => e.result!.attempts.flatMap((a) => a.tests?.failedNames ?? [])))].slice(0, 3);
    const runs = comparisons.reduce((n, e) => n + e.result!.attempts.length, 0);
    return {
      outcome: 'regression',
      detail: `Tests fail at the changed revision ${args.headSha.slice(0, 12)}${names.length ? ` (${names.join('; ')})` : ''} and the same selection passed at the base revision ${args.baseSha.slice(0, 12)} in ${runs}/${runs} runs.`,
    };
  }
  if (!basePasses) {
    return { outcome: 'inconclusive', detail: 'The failing tests also fail at the base revision, so the failure was not shown to be introduced by this change.' };
  }
  if (args.classification === 'flaky_test') {
    return { outcome: 'inconclusive', detail: 'The failure is intermittent at the changed revision; repeated runs did not show that the change introduced it.' };
  }
  return { outcome: 'inconclusive', detail: `The evidence does not support a regression attributable to the change (verdict: ${args.verdict ?? 'none'}, classification: ${(args.classification ?? 'unknown').replace(/_/g, ' ')}).` };
}

export function changeFixOutcome(patches: Pick<Patch, 'status'>[]): 'VALIDATED' | 'REJECTED' | 'NONE' {
  const f = fixOutcome(patches);
  return f === 'VERIFIED' ? 'VALIDATED' : f;
}

/** What a change verification did not examine. Always stated, whatever the outcome. */
export function notTestedFor(args: { outcome: ChangeOutcome; image: string | null; headTests: TestCounts | null; diffTruncated: boolean }): string[] {
  const out = [
    args.headTests
      ? `Only the repository's own automated tests were run (${args.headTests.total} at the changed revision); behaviour they do not exercise was not examined.`
      : "The repository's automated tests did not produce results at the changed revision.",
    `Tests ran offline${args.image ? ` in ${args.image}` : ''}; CI-specific configuration, services, secrets, and network access were not reproduced.`,
    'Code quality, security, performance, and documentation of the change were not assessed.',
    "The change's author or tooling was not identified; verification covers behaviour, not authorship.",
  ];
  if (args.outcome === 'no_regression_observed' || args.outcome === 'inconclusive') out.push('No fix was proposed unless a test failed at the changed revision.');
  if (args.outcome === 'blocked') out.push('No conclusion about the change was reached, because the required experiments could not run.');
  if (args.diffTruncated) out.push('The diff exceeded the analysis limit; only its first part was analysed.');
  return out;
}
