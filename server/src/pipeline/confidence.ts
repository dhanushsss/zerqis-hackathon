import { pct } from '../analysis/stats.js';
import type { Classification, ConfidenceAssessment, Experiment, Patch, Verdict } from '../domain/types.js';

/**
 * Confidence is derived from which discriminating experiments actually ran and
 * what they showed — never from a model's self-reported probability.
 */
export function assessConfidence(args: {
  classification: Classification;
  experiments: Experiment[];
  patches: Patch[];
  dependencyChanged: boolean;
  docsOnlyChange: boolean;
  corroboratingSources: number;
}): ConfidenceAssessment {
  const { classification, experiments } = args;
  const get = (k: Experiment['kind']) => experiments.find((e) => e.kind === k && e.result && e.status !== 'error' && e.status !== 'skipped');
  const reproduce = get('reproduce');
  const repeat = get('repeat');
  const parent = get('compare_parent');
  const validated = args.patches.filter((p) => p.status === 'validated');
  const basis: string[] = [];
  let points = 0;

  const reproduced = reproduce ? reproduce.result!.failures > 0 : null;
  if (reproduce) basis.push(reproduced ? 'Failure reproduced in a clean sandbox at the failing commit.' : 'Failure did not reproduce at the failing commit.');
  else basis.push('No reproduction experiment completed.');

  if (repeat) {
    const r = repeat.result!;
    const n = r.attempts.length;
    const fr = r.failureRate;
    basis.push(`Repeated ${n}×: ${r.failures} failed, ${r.passes} passed${fr ? ` (observed ${pct(fr.rate)}, 95% CI ${pct(fr.low)}–${pct(fr.high)})` : ''}.`);
  }
  if (parent) {
    const r = parent.result!;
    basis.push(`Parent commit: ${r.failures}/${r.attempts.length} runs failed.`);
  }

  switch (classification) {
    case 'code_regression':
    case 'dependency_regression': {
      if (reproduced) points++;
      if (repeat && repeat.result!.failures === repeat.result!.attempts.length) points++;
      if (parent && parent.result!.failures === 0) points++;
      if (classification === 'dependency_regression' && args.dependencyChanged) {
        points++;
        basis.push('The failing commit changes a dependency version.');
      }
      if (validated.length) {
        points += 2;
        basis.push(`A candidate fix passed the failing selection and the regression suite (${validated.map((p) => p.title).join('; ')}).`);
      }
      if (args.corroboratingSources) basis.push(`${args.corroboratingSources} external source(s) are consistent with this cause (treated as leads, not proof).`);
      break;
    }
    case 'flaky_test': {
      const r = repeat?.result;
      if (r && r.failures > 0 && r.failures < r.attempts.length) points += 2;
      if (parent && parent.result!.failures > 0) points++;
      if (args.docsOnlyChange) {
        points++;
        basis.push('The failing commit only changes documentation.');
      }
      if (validated.length) {
        points++;
        basis.push(`Remediation validated: ${validated.map((p) => p.title).join('; ')}.`);
      }
      if (r && r.attempts.length < 30) basis.push(`Sample size is ${r.attempts.length}; the true flake rate is uncertain.`);
      break;
    }
    default:
      if (args.corroboratingSources) basis.push(`${args.corroboratingSources} external source(s) mention a matching incident (leads only).`);
  }

  const label = points >= 4 ? 'strong' : points >= 2 ? 'moderate' : points >= 1 ? 'weak' : 'none';
  return { label, basis };
}

/** Caps a model's verdict at what the evidence rubric allows. */
export function reconcileVerdict(modelVerdict: Verdict, confidence: ConfidenceAssessment): { verdict: Verdict; adjusted: boolean; reason?: string } {
  if (modelVerdict === 'confirmed' && confidence.label !== 'strong') {
    return { verdict: 'probable', adjusted: true, reason: `"Confirmed" requires strong experimental evidence; the evidence rubric rates it ${confidence.label}.` };
  }
  if (modelVerdict !== 'inconclusive' && confidence.label === 'none') {
    return { verdict: 'inconclusive', adjusted: true, reason: 'No discriminating experiment completed.' };
  }
  return { verdict: modelVerdict, adjusted: false };
}

/** Deterministic summary of what fix validation actually showed (written after remediation). */
export function remediationSummary(patches: Patch[]): string | null {
  if (!patches.length) return null;
  const ok = patches.filter((p) => p.status === 'validated');
  const bad = patches.filter((p) => p.status === 'failed');
  const parts = [`Fix validation: ${ok.length} of ${patches.length} ${patches.length === 1 ? 'candidate' : 'candidates'} validated${ok.length ? ` (${ok.map((p) => p.title).join('; ')})` : ''}`];
  if (bad.length) parts.push(`${bad.length} failed validation (${bad.map((p) => p.title).join('; ')})`);
  return `${parts.join('; ')}.`;
}
