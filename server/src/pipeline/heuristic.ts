import type { CommitDiff } from '../analysis/diff.js';
import type { LogFacts } from '../analysis/logs.js';
import type { Classification, Experiment, Hypothesis } from '../domain/types.js';
import type { TriageOutput, VerdictOutput } from '../llm/schemas.js';

/**
 * Rule-based stand-ins for the model stages, used when no model is reachable.
 * Output is labeled "heuristic" everywhere it appears.
 */
export function heuristicTriage(facts: LogFacts, diff: CommitDiff | null, logLines: string[]): TriageOutput {
  const findLine = (re: RegExp) => {
    const i = logLines.findIndex((l) => re.test(l));
    return i >= 0 ? { quote: logLines[i].trim().slice(0, 200), line: i + 1 } : null;
  };
  const failLine = findLine(/●|<<< FAILURE!|cannot find symbol|COMPILATION ERROR|##\[error\]/);
  const ev = failLine ? [failLine] : [];
  const hyps: TriageOutput['hypotheses'] = [];
  const dep = diff?.dependencyChanges[0];

  if (facts.compileErrors.length && dep) {
    hyps.push({
      cause: `Upgrading ${dep.name} from ${dep.from} to ${dep.to} removed or changed an API used by the code (${facts.compileErrors[0].symbol ?? facts.compileErrors[0].message}).`,
      category: 'dependency_regression',
      supporting_evidence: ev,
      contradicting_evidence: [],
      prior: 'high',
      experiments: ['reproduce', 'compare_parent', 'external_search'],
      next_experiment: 'Build the failing commit and its parent in a clean sandbox.',
    });
  }
  const MANIFEST = /(^|\/)(pom\.xml|package(-lock)?\.json|build\.gradle(\.kts)?|yarn\.lock|pnpm-lock\.yaml)$/;
  const sourceChanges = diff?.files.filter((f) => !MANIFEST.test(f.path) && !/\.(md|txt)$/i.test(f.path)) ?? [];
  if (diff && !diff.onlyDocs && sourceChanges.length) {
    hyps.push({
      cause: `A source change in ${sourceChanges.filter((f) => !/test/i.test(f.path)).map((f) => f.path).join(', ') || 'this commit'} broke the behavior asserted by the failing test.`,
      category: 'code_regression',
      supporting_evidence: ev,
      contradicting_evidence: [],
      prior: dep ? 'low' : 'medium',
      experiments: ['reproduce', 'repeat', 'compare_parent'],
      next_experiment: 'Compare the failing test at this commit and its parent.',
    });
  }
  hyps.push({
    cause: 'The failing test is nondeterministic (timing, randomness, or ordering) and fails intermittently regardless of this change.',
    category: 'flaky_test',
    supporting_evidence: diff?.onlyDocs ? diff.files.map((f) => ({ quote: `diff --git a/${f.path} b/${f.path}` })) : [],
    contradicting_evidence: [],
    prior: diff?.onlyDocs ? 'high' : 'low',
    experiments: ['reproduce', 'repeat', 'compare_parent'],
    next_experiment: 'Run the failing test repeatedly with varied seeds.',
  });
  if (hyps.length < 3) {
    hyps.push({
      cause: 'A transient CI infrastructure or network problem caused the failure.',
      category: 'infrastructure',
      supporting_evidence: [],
      contradicting_evidence: [],
      prior: 'low',
      experiments: ['reproduce'],
      next_experiment: 'Re-run offline in a clean sandbox.',
    });
  }
  const queries = dep
    ? [`${dep.name} ${dep.to} release notes breaking changes ${facts.compileErrors[0]?.symbol?.replace(/\(.*\)/, '') ?? ''}`.trim()]
    : [];
  return {
    summary: `Heuristic triage: ${facts.signature}`,
    failure_signature: facts.signature,
    failing_tests: facts.failingTests.map((t) => ({ name: t.name, file: t.file })),
    environment_clues: [],
    implicated_dependencies: dep ? [{ name: dep.name, version: dep.to ?? undefined }] : [],
    hypotheses: hyps.slice(0, 4),
    search_queries: queries,
  };
}

export function heuristicVerdict(hypotheses: Hypothesis[], experiments: Experiment[], effects: Map<string, { s: number; c: number }>): VerdictOutput {
  const scored = hypotheses
    .map((h) => ({ h, score: (effects.get(h.key)?.s ?? 0) - 2 * (effects.get(h.key)?.c ?? 0) }))
    .sort((a, b) => b.score - a.score);
  const top = scored[0];
  const anyRun = experiments.some((e) => e.result && e.status !== 'error');
  const classification: Classification = top && top.score > 0 ? top.h.category : 'unknown';
  const remediation =
    classification === 'flaky_test' ? 'quarantine' : classification === 'dependency_regression' ? 'dependency_pin' : classification === 'code_regression' ? 'code_patch' : classification === 'infrastructure' ? 'retry' : 'none';
  return {
    classification,
    verdict: top && top.score >= 2 ? 'probable' : 'inconclusive',
    summary: top
      ? `Heuristic assessment: experiments most support ${top.h.key} (${top.h.cause})`
      : 'Heuristic assessment: no hypothesis is supported by the experiments.',
    primary_hypothesis: top?.h.key ?? 'H1',
    hypotheses: scored.map(({ h }) => {
      const e = effects.get(h.key) ?? { s: 0, c: 0 };
      return {
        id: h.key,
        status: e.c > 0 ? 'refuted' : e.s > 0 ? 'supported' : 'inconclusive',
        assessment: `${e.s} experiment(s) support and ${e.c} contradict this hypothesis.`,
      };
    }),
    recommended_action: anyRun ? 'Review the evidence ledger and the validated remediation below.' : 'Re-run with the experiment runner enabled.',
    remediation_type: remediation,
    limitations: ['Produced by deterministic rules because no model was available; wording is generic.'],
  };
}
