import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { Bundle, Investigation } from '../../api';
import { AgentOutcome } from './AgentOutcome';
import { Verdict } from './Verdict';

type Agent = NonNullable<Investigation['agent']>;
const DIAGNOSES: Agent['diagnosis'][] = ['CONFIRMED', 'PROBABLE', 'INCONCLUSIVE', 'BLOCKED'];
const FIXES: Agent['fix'][] = ['VERIFIED', 'REJECTED', 'NONE'];
const DIAGNOSIS_LABEL = { CONFIRMED: 'Cause confirmed', PROBABLE: 'Cause probable', INCONCLUSIVE: 'Cause inconclusive', BLOCKED: 'Diagnosis blocked' };
const FIX_LABEL = { VERIFIED: 'Fix verified', REJECTED: 'Fixes rejected', NONE: 'No validated fix' };

const agent = (diagnosis: Agent['diagnosis'], fix: Agent['fix']): Agent => ({
  iterations: 3, modelCalls: 3, executed: 1, rejected: 1, promptTokens: 1500, completionTokens: 240, elapsedMs: 40_000,
  stopReason: 'model_concluded', stopDetail: 'The model concluded that the evidence is sufficient.', patchRetries: 1, diagnosis, fix,
});

const outcome = () => ({
  diagnosis: within(screen.getByLabelText('Diagnosis outcome')),
  fix: within(screen.getByLabelText('Fix outcome')),
});

afterEach(cleanup);

describe('agent loop outcome: diagnosis and fix are shown separately', () => {
  for (const d of DIAGNOSES) {
    for (const f of FIXES) {
      it(`${d} + ${f}`, () => {
        render(<AgentOutcome agent={agent(d, f)} />);
        const o = outcome();
        expect(o.diagnosis.getByText(DIAGNOSIS_LABEL[d])).toBeVisible();
        expect(o.fix.getByText(FIX_LABEL[f])).toBeVisible();
        // Each panel shows only its own outcome.
        for (const other of Object.values(FIX_LABEL)) expect(o.diagnosis.queryByText(other)).toBeNull();
        for (const other of Object.values(DIAGNOSIS_LABEL)) expect(o.fix.queryByText(other)).toBeNull();
      });
    }
  }

  it('CONFIRMED + REJECTED: confirmed cause, rejected fixes, nothing reads as a working fix', () => {
    render(<AgentOutcome agent={agent('CONFIRMED', 'REJECTED')} />);
    const o = outcome();
    expect(o.diagnosis.getByText('Cause confirmed').closest('.badge')).toHaveClass('tone-pass');
    expect(o.fix.getByText('Fixes rejected').closest('.badge')).toHaveClass('tone-fail');
    expect(o.fix.getByText(/Every candidate fix failed validation/)).toBeVisible();
    expect(screen.queryByText('Fix verified')).toBeNull();
  });

  it('INCONCLUSIVE + NONE', () => {
    render(<AgentOutcome agent={agent('INCONCLUSIVE', 'NONE')} />);
    const o = outcome();
    expect(o.diagnosis.getByText('Cause inconclusive').closest('.badge')).toHaveClass('tone-warn');
    expect(o.fix.getByText('No validated fix').closest('.badge')).toHaveClass('tone-neutral');
  });

  it('successful diagnosis with no validated remediation is not shown as fixed', () => {
    for (const d of ['CONFIRMED', 'PROBABLE'] as const) {
      render(<AgentOutcome agent={agent(d, 'NONE')} />);
      const o = outcome();
      expect(o.diagnosis.getByText(DIAGNOSIS_LABEL[d])).toBeVisible();
      expect(o.fix.getByText('No validated fix')).toBeVisible();
      expect(screen.queryByText('Fix verified')).toBeNull();
      cleanup();
    }
  });

  it('shows the loop summary and stop reason from the backend', () => {
    render(<AgentOutcome agent={{ ...agent('PROBABLE', 'NONE'), iterations: 1, executed: 0, rejected: 2, patchRetries: 0, stopDetail: 'Two consecutive proposals were rejected by policy.' }} />);
    expect(screen.getByText(/1 iteration · 0 experiments executed · 2 proposals rejected by policy · 0 patch retries\. Stopped: Two consecutive proposals were rejected by policy\./)).toBeVisible();
  });

  it('renders nothing when the loop did not run (ALIBI_LOOP off)', () => {
    const { container } = render(<AgentOutcome agent={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('verdict card', () => {
  const bundle = (a?: Agent): Bundle =>
    ({
      investigation: {
        id: 'inv_x', status: 'completed', stage: 'Complete', verdict: 'confirmed', classification: 'code_regression', summary: 's',
        confidence: { label: 'strong', basis: [] }, primaryHypothesis: null, recommendedAction: null, limitations: [], verdictHistory: [], ...(a ? { agent: a } : {}),
      },
      hypotheses: [], experiments: [], evidence: [], sources: [], patches: [], modelCalls: [], queuePosition: -1,
    }) as unknown as Bundle;

  it('includes the outcome panel next to the verdict when the loop ran', () => {
    render(<MemoryRouter><Verdict b={bundle(agent('CONFIRMED', 'REJECTED'))} /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: 'Agent loop outcome' })).toBeVisible();
    expect(outcome().fix.getByText('Fixes rejected')).toBeVisible();
  });

  it('is unchanged when the loop is off', () => {
    render(<MemoryRouter><Verdict b={bundle()} /></MemoryRouter>);
    expect(screen.queryByRole('heading', { name: 'Agent loop outcome' })).toBeNull();
  });
});
