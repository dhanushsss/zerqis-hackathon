import { act, render, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Experiment } from './api';
import { AttemptStrip, modeDecided, useChangeFlash } from './components/ui';
import { stages } from './pages/detail/derive';

const exp = (outcomes: boolean[], planned = 3, status: Experiment['status'] = 'running'): Experiment =>
  ({
    id: 'e', investigationId: 'i', hypothesisKey: null, kind: 'repeat', title: 't', reason: '', status, backend: 'docker', command: null, environment: null,
    commitSha: null, testSelection: null, plannedAttempts: planned, startedAt: null, finishedAt: null, durationMs: null, observation: null, effect: null, patchId: null,
    result: { attempts: outcomes.map((p, i) => ({ index: i + 1, exitCode: p ? 0 : 1, passed: p, timedOut: false, durationMs: 10, tests: null, outputTail: '' })), passes: 0, failures: 0 },
  }) as Experiment;

describe('state-driven motion', () => {
  it('useChangeFlash never fires on first render and fires once on a real change', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ v }) => useChangeFlash(v, (a, b) => a === 'validating' && b === 'validated', 1000), { initialProps: { v: 'validated' } });
    expect(result.current).toBe(false);
    rerender({ v: 'validating' });
    expect(result.current).toBe(false);
    rerender({ v: 'validated' });
    expect(result.current).toBe(true);
    act(() => vi.advanceTimersByTime(1100));
    expect(result.current).toBe(false);
    rerender({ v: 'failed' });
    expect(result.current).toBe(false);
    vi.useRealTimers();
  });

  it('animates only run results that arrive after mount', () => {
    const { container, rerender } = render(<AttemptStrip exp={exp([true])} />);
    expect(container.querySelectorAll('.arrived')).toHaveLength(0);
    rerender(<AttemptStrip exp={exp([true, false])} />);
    const arrived = container.querySelectorAll('.attempt.arrived');
    expect(arrived).toHaveLength(1);
    expect(arrived[0].className).toContain('fail');
    rerender(<AttemptStrip exp={exp([true, false])} />);
    expect(container.querySelectorAll('.arrived')).toHaveLength(0);
  });

  it('does not show a reasoning mode before the backend has decided it', () => {
    expect(modeDecided({ status: 'queued', stage: 'Queued' })).toBe(false);
    expect(modeDecided({ status: 'running', stage: 'Collecting failure evidence' })).toBe(false);
    expect(modeDecided({ status: 'running', stage: 'Forming hypotheses' })).toBe(true);
    expect(modeDecided({ status: 'failed', stage: 'Failed' })).toBe(true);
  });

  it('marks the verdict stage inconclusive only when the finished verdict is inconclusive', () => {
    const base = {
      investigation: { status: 'inconclusive', stage: 'Complete', verdict: 'inconclusive', confidence: { label: 'none', basis: [] }, logStats: { totalLines: 1, excerptCount: 1 }, remediationType: 'none' },
      hypotheses: [{}], experiments: [], patches: [],
    } as never;
    expect(stages(base).find((s) => s.key === 'verdict')!.state).toBe('inconclusive');
    const running = { ...(base as object), investigation: { ...(base as { investigation: object }).investigation, status: 'running', stage: 'Weighing evidence' } } as never;
    expect(stages(running).find((s) => s.key === 'verdict')!.state).toBe('running');
  });
});
