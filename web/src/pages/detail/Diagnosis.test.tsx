import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { Bundle } from '../../api';
import { ToastProvider } from '../../components/ui';
import codeRegression from '../../test-fixtures/code-regression.json';
import maven from '../../test-fixtures/maven-dependency.json';
import { Hypotheses } from './Hypotheses';
import { Remediation } from './Remediation';

const cr = codeRegression as unknown as Bundle;
const mv = maven as unknown as Bundle;

const renderIn = (node: React.ReactNode) =>
  render(
    <MemoryRouter>
      <ToastProvider>{node}</ToastProvider>
    </MemoryRouter>,
  );

describe('hypothesis cards', () => {
  it('say why each hypothesis survived or was rejected, from recorded effects only', () => {
    renderIn(<Hypotheses b={mv} />);
    const h1 = screen.getByRole('article', { name: /Guava 21\.0 removed deprecated toStringHelper/ });
    expect(within(h1).getByText(/^Survived: 2 supporting results and none against it\.$/)).toBeVisible();
    // H2 was rejected in the final assessment although no experiment contradicted it: say exactly that.
    const h2 = screen.getByRole('article', { name: /InventoryItem\.java source code references removed API/ });
    expect(within(h2).getByText('Rejected in the final assessment; no experiment contradicted it directly.')).toBeVisible();
    const h3 = screen.getByRole('article', { name: /Maven compiler plugin configuration/ });
    expect(within(h3).getByText(/^Unresolved: 0 supporting, 1 contradicting/)).toBeVisible();
  });

  it('marks a contradicted hypothesis with the experiments that contradicted it', () => {
    renderIn(<Hypotheses b={cr} />);
    const h3 = screen.getByRole('article', { name: /Object\.freeze/ });
    expect(within(h3).getByText(/^Rejected: contradicted by Reproduce\.$/)).toBeVisible();
  });
});

describe('remediation', () => {
  it('shows targeted runs and the full regression suite as separate validation results', () => {
    renderIn(<Remediation b={cr} publicDemo={false} />);
    const card = screen.getByRole('article', { name: /Targeted fix by Nemotron/ });
    const results = within(card).getByLabelText('Validation results');
    expect(within(results).getByText('Targeted: 3/3 runs passed')).toBeVisible();
    expect(within(results).getByText('Regression suite: passed')).toBeVisible();
    expect(within(results).getAllByRole('link')).toHaveLength(2);
  });

  it('never shows a failed candidate as validated, and says why the suite did not run separately', () => {
    renderIn(<Remediation b={mv} publicDemo={false} />);
    const card = screen.getByRole('article', { name: /Targeted fix by Nemotron/ });
    expect(within(card).getByText('Validation failed', { selector: '.badge' })).toBeVisible();
    expect(within(card).getByText('Targeted: 0/3 runs passed')).toBeVisible();
    expect(within(card).getByText('Targeted run was the full build and suite.')).toBeVisible();
    expect(within(card).queryByText('Validated fix')).toBeNull();
  });

  it('keeps short diffs open and puts long diffs behind a labelled disclosure', () => {
    renderIn(<Remediation b={cr} publicDemo={false} />);
    const revert = screen.getByRole('article', { name: /Revert src\/discounts\.js/ });
    const toggle = within(revert).getByText(/^Show diff \(\d+ lines across 2 files\)$/);
    expect(toggle.closest('details')).not.toHaveAttribute('open');
    const targeted = screen.getByRole('article', { name: /Targeted fix by Nemotron/ });
    expect(within(targeted).queryByText(/^Show diff/)).toBeNull();
    expect(within(targeted).getByRole('region', { name: /Patch diff/ })).toBeVisible();
  });

  it('labels a patch with no recorded runs as proposed only, never validated', () => {
    const p = { ...cr.patches[0], status: 'proposed' as const };
    const b = { ...cr, patches: [p], experiments: cr.experiments.filter((e) => e.patchId !== p.id) };
    renderIn(<Remediation b={b} publicDemo={false} />);
    expect(screen.getByText('Proposed only: not validated.')).toBeVisible();
    expect(screen.getByText('Proposed — not validated')).toBeVisible();
  });
});
