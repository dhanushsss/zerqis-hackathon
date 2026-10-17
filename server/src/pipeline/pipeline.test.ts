import { describe, expect, it } from 'vitest';
import type { Experiment, Hypothesis, Patch } from '../domain/types.js';
import { assessConfidence, reconcileVerdict, remediationSummary } from './confidence.js';
import { experimentEffect } from './effects.js';
import { attemptSeed } from './experiments.js';
import { heuristicTriage } from './heuristic.js';
import { pinCandidate, quarantineCandidate } from './remediation.js';
import { extractFacts } from '../analysis/logs.js';
import { wilson } from '../analysis/stats.js';
import { analyzeDiff } from '../analysis/diff.js';

function exp(kind: Experiment['kind'], outcomes: boolean[], extra: Partial<Experiment> = {}): Experiment {
  const attempts = outcomes.map((passed, i) => ({ index: i + 1, exitCode: passed ? 0 : 1, passed, timedOut: false, durationMs: 1000, tests: null, outputTail: '' }));
  const failures = outcomes.filter((p) => !p).length;
  return {
    id: `exp_${kind}`, investigationId: 'inv', hypothesisKey: 'H1', kind, title: kind, reason: '', status: failures ? 'failed' : 'passed', backend: 'docker',
    command: [], environment: null, commitSha: 'abc', testSelection: null, plannedAttempts: outcomes.length, startedAt: null, finishedAt: null, durationMs: 1,
    result: { attempts, passes: outcomes.length - failures, failures, failureRate: outcomes.length > 1 ? wilson(failures, outcomes.length) : undefined }, observation: null, effect: null, patchId: null, ...extra,
  };
}
const hyp = (category: Hypothesis['category']): Hypothesis => ({
  id: 'h', investigationId: 'inv', key: 'H1', cause: '', category, origin: 'model', supporting: [], contradicting: [], prior: 'medium', status: 'open', assessment: null, nextExperiment: null, rank: 0,
});

describe('experiment effects (deterministic rules)', () => {
  it('intermittent repeats support flakiness and contradict a regression', () => {
    const e = exp('repeat', [true, false, true, true, false, true, true, true, true, true]);
    expect(experimentEffect(e, hyp('flaky_test')).effect).toBe('supports');
    expect(experimentEffect(e, hyp('code_regression')).effect).toBe('contradicts');
  });
  it('consistent failures contradict flakiness', () => {
    const e = exp('repeat', Array(10).fill(false));
    expect(experimentEffect(e, hyp('flaky_test')).effect).toBe('contradicts');
    expect(experimentEffect(e, hyp('code_regression')).effect).toBe('supports');
  });
  it('a passing parent supports a regression; a failing parent contradicts it', () => {
    expect(experimentEffect(exp('compare_parent', [true, true, true]), hyp('code_regression')).effect).toBe('supports');
    expect(experimentEffect(exp('compare_parent', [false, true, true]), hyp('code_regression')).effect).toBe('contradicts');
  });
  it('a single passing retry never proves causation', () => {
    expect(experimentEffect(exp('reproduce', [true]), hyp('flaky_test')).effect).toBe('supports');
    expect(experimentEffect(exp('reproduce', [true]), hyp('flaky_test')).why).toMatch(/consistent with/);
  });
  it('ignores experiments that errored', () => {
    expect(experimentEffect(exp('repeat', [false], { status: 'error' }), hyp('flaky_test')).effect).toBe('neutral');
  });
});

describe('confidence and verdict reconciliation', () => {
  const validated: Patch = { id: 'p', investigationId: 'inv', origin: 'deterministic', strategy: 'code_patch', title: 'fix', rationale: '', diff: '', files: [], status: 'validated', validation: null, prUrl: null, prBranch: null, createdAt: '' };
  it('rates a reproduced, parent-discriminated, fixed regression as strong', () => {
    const c = assessConfidence({ classification: 'code_regression', experiments: [exp('reproduce', [false]), exp('repeat', [false, false, false]), exp('compare_parent', [true, true])], patches: [validated], dependencyChanged: false, docsOnlyChange: false, corroboratingSources: 0 });
    expect(c.label).toBe('strong');
    expect(c.basis.join(' ')).toMatch(/Parent commit: 0\/2/);
  });
  it('rates an unreproduced hypothesis with no experiments as weak or none', () => {
    const c = assessConfidence({ classification: 'code_regression', experiments: [], patches: [], dependencyChanged: false, docsOnlyChange: false, corroboratingSources: 0 });
    expect(c.label).toBe('none');
  });
  it('caps a model "confirmed" verdict when evidence is not strong', () => {
    expect(reconcileVerdict('confirmed', { label: 'moderate', basis: [] })).toMatchObject({ verdict: 'probable', adjusted: true });
    expect(reconcileVerdict('probable', { label: 'none', basis: [] })).toMatchObject({ verdict: 'inconclusive', adjusted: true });
    expect(reconcileVerdict('confirmed', { label: 'strong', basis: [] })).toMatchObject({ verdict: 'confirmed', adjusted: false });
  });
  it('flags small flake samples as uncertain', () => {
    const c = assessConfidence({ classification: 'flaky_test', experiments: [exp('repeat', [true, false, true, true, true, true, true, true, true, true])], patches: [], dependencyChanged: false, docsOnlyChange: true, corroboratingSources: 0 });
    expect(c.basis.join(' ')).toMatch(/Sample size is 10/);
    expect(c.basis.join(' ')).toMatch(/95% CI/);
  });
});

describe('remediation summary', () => {
  const mk = (title: string, status: Patch['status']): Patch => ({ id: title, investigationId: 'inv', origin: 'deterministic', strategy: 'code_patch', title, rationale: '', diff: '', files: [], status, validation: null, prUrl: null, prBranch: null, createdAt: '' });
  it('summarises validated and failed candidates from actual statuses', () => {
    expect(remediationSummary([mk('Model fix', 'failed'), mk('Pin guava back to 20.0', 'validated')])).toBe(
      'Fix validation: 1 of 2 candidates validated (Pin guava back to 20.0); 1 failed validation (Model fix).',
    );
    expect(remediationSummary([mk('Quarantine x', 'proposed')])).toBe('Fix validation: 0 of 1 candidate validated.');
    expect(remediationSummary([])).toBeNull();
  });
});

describe('remediation candidates', () => {
  it('quarantines only the matching test', () => {
    const content = "test('a', () => {});\n  test('delivers in order', () => {\n  });\n";
    const c = quarantineCandidate({ testFile: 't.test.js', testFullName: 'suite delivers in order', content, investigationId: 'inv_1', failureSummary: 'failed 2/10' })!;
    expect(c.edits[0].content).toContain("test.skip('delivers in order'");
    expect(c.edits[0].content).toContain("test('a'");
    expect(c.edits[0].content).toContain('Quarantined by Alibi (investigation inv_1)');
  });
  it('pins the exact changed dependency line', () => {
    const diff = analyzeDiff('diff --git a/pom.xml b/pom.xml\n-  <guava.version>20.0</guava.version>\n+  <guava.version>21.0</guava.version>\n', '1\t1\tpom.xml');
    const c = pinCandidate(diff, () => '<p>\n  <guava.version>21.0</guava.version>\n</p>')!;
    expect(c.edits[0].content).toBe('<p>\n  <guava.version>20.0</guava.version>\n</p>');
  });
});

describe('heuristic fallback', () => {
  it('produces schema-shaped hypotheses including a dependency hypothesis for a version bump', () => {
    const facts = extractFacts('[ERROR] /work/src/A.java:[3,4] cannot find symbol\n[ERROR]   symbol:   method foo()\n[ERROR]   location: class Bar');
    const diff = analyzeDiff('diff --git a/pom.xml b/pom.xml\n-  <guava.version>20.0</guava.version>\n+  <guava.version>21.0</guava.version>\n', '1\t1\tpom.xml');
    const t = heuristicTriage(facts, diff, []);
    expect(t.hypotheses[0].category).toBe('dependency_regression');
    expect(t.hypotheses.some((h) => h.category === 'code_regression')).toBe(false);
    expect(t.search_queries[0]).toContain('guava 21.0');
  });
  it('uses a fixed, replayable seed sequence', () => {
    expect([1, 2, 3].map(attemptSeed)).toEqual([65537, 131074, 196611]);
  });
});
