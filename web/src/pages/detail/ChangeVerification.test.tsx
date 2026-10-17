import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { Bundle, ChangeVerification, Patch } from '../../api';
import fixture from '../../test-fixtures/code-regression.json';
import { ChangeVerificationPanel } from './ChangeVerification';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);

function bundle(change: Partial<ChangeVerification>, patches: Array<Pick<Patch, 'status'>> = [], verdict: 'confirmed' | null = null): Bundle {
  const b = structuredClone(fixture) as unknown as Bundle;
  b.investigation = {
    ...b.investigation,
    source: 'change',
    verdict,
    change: {
      origin: { kind: 'sample', scenarioId: 'code-regression' },
      fromInvestigationId: null,
      requested: { base: BASE.slice(0, 7), head: HEAD.slice(0, 7) },
      baseSha: BASE,
      headSha: HEAD,
      outcome: null,
      outcomeDetail: null,
      fix: null,
      examined: [],
      notTested: [],
      ...change,
    },
  };
  b.patches = patches as Patch[];
  return b;
}

const show = (b: Bundle) =>
  render(
    <MemoryRouter>
      <ChangeVerificationPanel b={b} />
    </MemoryRouter>,
  );
const panel = () => within(screen.getByRole('region', { name: 'Change verification' }));

afterEach(cleanup);

describe('change verification panel', () => {
  const examined: ChangeVerification['examined'] = [
    { revision: 'head', sha: HEAD, experimentId: 'exp_h', status: 'failed', tests: { total: 4, passed: 2, failed: 2, failedNames: [] } },
    { revision: 'base', sha: BASE, experimentId: 'exp_b', status: 'passed', tests: { total: 4, passed: 4, failed: 0, failedNames: [] } },
  ];

  it('regression with a rejected fix: both outcomes, scope, and what was not examined', () => {
    show(bundle({ outcome: 'regression', outcomeDetail: 'Tests fail at the changed revision.', fix: 'REJECTED', examined, notTested: ['Code quality was not assessed.'] }, [{ status: 'failed' }], 'confirmed'));
    const p = panel();
    expect(p.getByText('Regression supported')).toBeVisible();
    expect(p.getByText('Candidate fix rejected')).toBeVisible();
    expect(p.queryByText('Candidate fix validated')).toBeNull();
    const rows = within(p.getByRole('table')).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent(/Changed.*Failed.*2 failed \/ 4/);
    expect(rows[2]).toHaveTextContent(/Base.*Passed.*0 failed \/ 4/);
    expect(p.getByText('Code quality was not assessed.')).toBeVisible();
    expect(p.getByText(/not who or what wrote it/)).toBeVisible();
  });

  it('a validated fix is labelled validated only when the backend says so', () => {
    show(bundle({ outcome: 'regression', fix: 'VALIDATED', examined }, [{ status: 'validated' }], 'confirmed'));
    expect(panel().getByText('Candidate fix validated')).toBeVisible();
  });

  it.each([
    ['no_regression_observed', 'No regression observed', 'No fix needed'],
    ['inconclusive', 'Inconclusive', 'No fix proposed'],
    ['blocked', 'Blocked', 'No fix proposed'],
  ] as const)('%s', (outcome, label, fix) => {
    show(bundle({ outcome, outcomeDetail: 'detail text', fix: 'NONE' }));
    expect(panel().getByText(label)).toBeVisible();
    expect(panel().getByText(fix)).toBeVisible();
    expect(panel().queryByText('Regression supported')).toBeNull();
  });

  it('never labels authorship as AI-generated', () => {
    show(bundle({ outcome: 'regression', fix: 'NONE', examined }));
    expect(screen.queryByText(/AI[- ]generated/i)).toBeNull();
  });

  it('while running it shows the requested revisions and no outcome', () => {
    show(bundle({ baseSha: null, headSha: null }));
    expect(panel().getByText('Verifying')).toBeVisible();
    expect(panel().getByText(/Running the test suite at both revisions/)).toBeVisible();
  });
});
