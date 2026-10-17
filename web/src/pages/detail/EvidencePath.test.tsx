import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { Bundle } from '../../api';
import codeRegression from '../../test-fixtures/code-regression.json';
import flaky from '../../test-fixtures/flaky-jest.json';
import maven from '../../test-fixtures/maven-dependency.json';
import { EvidencePath } from './EvidencePath';

const B = (x: unknown) => x as Bundle;

function Where() {
  const l = useLocation();
  return <div data-testid="where">{`${l.pathname}${l.search}${l.hash}`}</div>;
}

function renderPath(b: Bundle) {
  const id = b.investigation.id;
  return render(
    <MemoryRouter initialEntries={[`/investigations/${id}`]}>
      <Routes>
        <Route path="/investigations/:id" element={<EvidencePath b={b} />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}
const node = (name: RegExp) => screen.getByRole('button', { name });

describe('Evidence Path', () => {
  it('renders all five steps for a completed code-regression investigation', () => {
    const b = B(codeRegression);
    renderPath(b);
    const steps = screen.getByRole('list', { name: 'Evidence path steps' });
    for (const t of ['Failure', 'Hypotheses', 'Experiments', 'Diagnosis', 'Remediation']) expect(within(steps).getByText(new RegExp(`\\d\\. ${t}`))).toBeInTheDocument();
    expect(node(/^Diagnosis: Confirmed\. Confirmed\./)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Remediation: .*Validated fix/ })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /^Hypotheses: H\d/ })).toHaveLength(b.hypotheses.length);
  });

  it('shows the flaky repeat experiment with its actual passed and failed runs', () => {
    renderPath(B(flaky));
    const repeat = node(/^Experiments: Run the failing test 10× .*Intermittent\. 2\/10 runs failed/);
    expect(within(repeat).getByRole('img', { name: '8 passed, 2 failed of 10 planned runs' })).toBeInTheDocument();
  });

  it('marks a hypothesis contradicted by an experiment as contradicted', () => {
    const b = B(codeRegression);
    renderPath(b);
    const refuted = b.hypotheses.find((h) => h.status === 'refuted')!;
    expect(node(new RegExp(`^Hypotheses: ${refuted.key}\\. Contradicted\\.`))).toBeInTheDocument();
  });

  it('never shows a skipped experiment as successful', () => {
    renderPath(B(maven));
    const skipped = screen.getAllByRole('button', { name: /^Experiments: .*\. Skipped\. Skipped: not executed/ });
    expect(skipped.length).toBeGreaterThanOrEqual(1);
    for (const s of skipped) expect(s).not.toHaveTextContent(/Tests passed/);
  });

  it('distinguishes validated, failed, and proposed fixes', () => {
    const b = B(maven);
    const { unmount } = renderPath(b);
    expect(screen.getByRole('button', { name: /^Remediation: Pin guava back to 20\.0\. Validated fix\./ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Remediation: Targeted fix by .*\. Validation failed\./ })).toBeInTheDocument();
    unmount();
    renderPath({ ...b, patches: [{ ...b.patches[0], status: 'proposed', validation: null }] });
    expect(screen.getByRole('button', { name: /^Remediation: .*Proposed · not validated\. Not validated yet/ })).toBeInTheDocument();
  });

  it('renders partial data without crashing', () => {
    const b = B(flaky);
    renderPath({ ...b, investigation: { ...b.investigation, verdict: null, confidence: null, primaryHypothesis: null, failureSignature: null, status: 'running', stage: 'Forming hypotheses' }, hypotheses: [], experiments: [], evidence: [], patches: [], sources: [] });
    expect(screen.getByText('Not formed yet.')).toBeInTheDocument();
    expect(screen.getByText('Not planned yet.')).toBeInTheDocument();
    expect(node(/^Diagnosis: No verdict yet/)).toBeInTheDocument();
  });

  it('selecting an experiment reveals its recorded relationships and opens the existing experiment page', () => {
    const b = B(flaky);
    renderPath(b);
    const exp = b.experiments.find((e) => e.kind === 'repeat')!;
    fireEvent.click(node(/^Experiments: Run the failing test 10×/));
    expect(node(/^Experiments: Run the failing test 10×/)).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Recorded relationships')).toBeInTheDocument();
    expect(screen.getByText(/supports →/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: /Open experiment/ }));
    expect(screen.getByTestId('where')).toHaveTextContent(`/investigations/${b.investigation.id}/experiments/${exp.id}`);
  });

  it('opens the exact ledger record for an observed fact', () => {
    const b = B(flaky);
    renderPath(b);
    const fact = b.evidence.find((e) => e.title.startsWith('CI run used Jest seed'))!;
    fireEvent.click(node(/^Failure: CI run used Jest seed/));
    fireEvent.click(screen.getByRole('link', { name: `Ledger record #${fact.seq}` }));
    expect(screen.getByTestId('where')).toHaveTextContent(`/investigations/${b.investigation.id}/ledger#${fact.id}`);
  });

  it('supports arrow-key movement and Escape', () => {
    renderPath(B(codeRegression));
    const first = node(/^Failure: CI failure/);
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^Hypotheses: H1/);
    fireEvent.click(document.activeElement as HTMLElement);
    expect(document.activeElement).toHaveAttribute('aria-pressed', 'true');
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    expect(screen.queryAllByRole('button', { pressed: true })).toHaveLength(0);
  });

  it('does not replay animations for a completed investigation, and animates a real state change', () => {
    const b = B(flaky);
    const { container, rerender } = renderPath(b);
    expect(container.querySelectorAll('.changed')).toHaveLength(0);
    const h = b.hypotheses[0];
    const changed = { ...b, hypotheses: b.hypotheses.map((x) => (x.id === h.id ? { ...x, status: x.status === 'supported' ? 'inconclusive' : 'supported' } : x)) } as Bundle;
    act(() => {
      rerender(
        <MemoryRouter initialEntries={[`/investigations/${b.investigation.id}`]}>
          <Routes>
            <Route path="/investigations/:id" element={<EvidencePath b={changed} />} />
          </Routes>
        </MemoryRouter>,
      );
    });
    expect(container.querySelectorAll('.pnode.changed')).toHaveLength(1);
  });
});
