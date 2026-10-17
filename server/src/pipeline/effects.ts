import type { Classification, Experiment, Hypothesis } from '../domain/types.js';

export type Effect = 'supports' | 'contradicts' | 'neutral';

const DETERMINISTIC: Classification[] = ['code_regression', 'dependency_regression'];
const INTERMITTENT: Classification[] = ['flaky_test', 'infrastructure', 'external_outage'];

/**
 * Deterministic rules for how an experiment's observed outcome bears on a
 * hypothesis category. These rules — not the model — decide the ledger's
 * supports/contradicts markers.
 */
export function experimentEffect(exp: Experiment, h: Hypothesis): { effect: Effect; why: string } {
  const r = exp.result;
  if (!r || exp.status === 'error' || exp.status === 'skipped') return { effect: 'neutral', why: 'No usable result.' };
  const n = r.attempts.length;
  const det = DETERMINISTIC.includes(h.category);
  const inter = INTERMITTENT.includes(h.category);

  switch (exp.kind) {
    case 'reproduce':
      if (r.failures > 0) {
        if (det) return { effect: 'supports', why: 'The failure reproduced in a clean sandbox at the failing commit.' };
        if (h.category === 'infrastructure' || h.category === 'external_outage')
          return { effect: 'contradicts', why: 'The failure reproduced offline in a clean sandbox, away from the original CI infrastructure.' };
        return { effect: 'neutral', why: 'Reproduction alone does not distinguish a flaky test from a deterministic one.' };
      }
      if (det) return { effect: 'contradicts', why: 'The failing commit passed in a clean sandbox.' };
      return { effect: 'supports', why: 'The failure did not reproduce, consistent with an intermittent cause.' };

    case 'repeat': {
      if (r.failures > 0 && r.failures < n) {
        if (h.category === 'flaky_test') return { effect: 'supports', why: `Same commit, same code: ${r.failures}/${n} runs failed and ${r.passes}/${n} passed.` };
        if (det) return { effect: 'contradicts', why: `A deterministic regression should fail every run; ${r.passes}/${n} runs passed.` };
        return { effect: 'neutral', why: 'Intermittent in an offline sandbox, which points at the test rather than external infrastructure.' };
      }
      if (r.failures === n) {
        if (h.category === 'flaky_test') return { effect: 'contradicts', why: `Failed ${n}/${n} runs with varied seeds — not intermittent at this sample size.` };
        if (det) return { effect: 'supports', why: `Failed deterministically: ${n}/${n} runs.` };
        return { effect: 'neutral', why: 'Consistent failure offline.' };
      }
      if (inter) return { effect: 'supports', why: `Passed ${n}/${n} runs; the original failure was not observed again.` };
      return { effect: 'contradicts', why: `Passed ${n}/${n} runs at the failing commit.` };
    }

    case 'compare_parent': {
      const parentFailed = r.failures > 0;
      if (!parentFailed) {
        if (det) return { effect: 'supports', why: `The parent commit passed ${r.passes}/${n} runs of the same selection.` };
        if (h.category === 'flaky_test') return { effect: 'neutral', why: `The parent passed ${n}/${n}; a low-rate flake can still pass a small sample.` };
        return { effect: 'neutral', why: 'Parent passed.' };
      }
      if (det) return { effect: 'contradicts', why: `The parent commit fails the same way (${r.failures}/${n}), so this commit did not introduce it.` };
      if (h.category === 'flaky_test') return { effect: 'supports', why: `The parent commit shows the same failure (${r.failures}/${n}); it predates this commit.` };
      return { effect: 'neutral', why: 'Parent also fails.' };
    }

    case 'validate_patch':
    case 'regression_suite':
      return { effect: 'neutral', why: 'Patch validation is assessed on the remediation, not on competing hypotheses.' };

    default:
      return { effect: 'neutral', why: '' };
  }
}
