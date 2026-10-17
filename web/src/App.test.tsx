import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

const inv = {
  id: 'inv_test0001', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'completed', stage: 'Complete', source: 'demo', scenarioId: 'flaky-jest',
  mode: 'replay', repository: 'alibi-demo/checkout-service', repoUrl: null, commitSha: '8aac301d93aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', parentSha: '33b2d8e8be3caaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  branch: 'main', workflow: 'CI', job: 'test', runId: null, runUrl: null, prNumber: null, prUrl: null, commitMessage: 'docs: tuning knobs', commitAuthor: 'Sam',
  framework: 'jest', failureSignature: 'jest: test/retryQueue.test.js › planDeliveries delivers notifications in submission order', classification: 'flaky_test', summary: 'Intermittent ordering failure.',
  verdict: 'confirmed', confidence: { label: 'strong', basis: ['Repeated 10×: 2 failed, 8 passed (observed 20%, 95% CI 6%–51%).'] }, primaryHypothesis: 'H1', recommendedAction: 'Quarantine and fix the jitter.',
  remediationType: 'quarantine', limitations: ['Sample size is small.'], error: null, logStats: { totalLines: 64, totalChars: 4000, sentChars: 800, excerptCount: 2, redactions: 0 },
  modelsUsed: { triage: 'nvidia/nemotron (replay)' }, verdictHistory: [{ at: '', stage: 'Experiments weighed', verdict: 'probable', confidence: 'strong', note: 'Evidence rubric: strong.' }],
  options: { repeat: 10, requestedMode: 'auto' }, artifacts: [],
};
const exp = {
  id: 'exp_rep', investigationId: inv.id, hypothesisKey: 'H1', kind: 'repeat', title: 'Run the failing test 10× with varied seeds', reason: 'Measures intermittency.', status: 'failed', backend: 'docker',
  command: ['node', 'node_modules/jest/bin/jest.js'], environment: { network: 'none' }, commitSha: inv.commitSha, testSelection: 'x', plannedAttempts: 3, startedAt: inv.createdAt, finishedAt: inv.createdAt, durationMs: 3000,
  result: { attempts: [true, false, true].map((p, i) => ({ index: i + 1, exitCode: p ? 0 : 1, passed: p, timedOut: false, durationMs: 1000, seed: (i + 1) * 65537, tests: { total: 5, passed: p ? 5 : 4, failed: p ? 0 : 1, failedNames: p ? [] : ['planDeliveries delivers notifications in submission order'] }, outputTail: 'FAIL test/retryQueue.test.js' })), passes: 2, failures: 1 },
  observation: '1/3 runs failed', effect: 'Supports H1', patchId: null,
};
const bundle = {
  investigation: inv,
  hypotheses: [{ id: 'h1', investigationId: inv.id, key: 'H1', cause: 'The test depends on random jitter.', category: 'flaky_test', origin: 'replay', supporting: [{ text: 'Seed: 1849273600', logLine: 55, verified: true }], contradicting: [], prior: 'high', status: 'supported', assessment: null, nextExperiment: null, rank: 0 }],
  experiments: [exp],
  evidence: [
    { id: 'ev1', investigationId: inv.id, seq: 1, kind: 'observed_fact', title: 'CI run used Jest seed 1849273600', detail: '', hypothesisKey: null, experimentId: null, sourceId: null, effect: null, provenance: { type: 'log', lines: [55, 55] }, createdAt: inv.createdAt },
    { id: 'ev2', investigationId: inv.id, seq: 2, kind: 'experiment_result', title: 'Repeat: 1/3 failed', detail: '', hypothesisKey: 'H1', experimentId: 'exp_rep', sourceId: null, effect: null, provenance: { type: 'experiment', ref: 'exp_rep' }, createdAt: inv.createdAt },
  ],
  sources: [],
  patches: [{ id: 'patch_1', investigationId: inv.id, origin: 'deterministic', strategy: 'quarantine', title: 'Quarantine "delivers notifications in submission order"', rationale: 'Skips only the flaky test.', diff: 'diff --git a/test/a.test.js b/test/a.test.js\n--- a/test/a.test.js\n+++ b/test/a.test.js\n@@ -1,1 +1,1 @@\n-test(\'x\')\n+test.skip(\'x\')\n', files: ['test/a.test.js'], status: 'validated', validation: { summary: 'Passed 10/10 targeted runs and the full regression suite.' }, prUrl: null, prBranch: null, createdAt: '' }],
  modelCalls: [], queuePosition: -1,
};

const routes: Record<string, unknown> = {
  '/api/status': { publicDemo: false, nebius: { configured: false, baseUrl: 'https://tf', models: null }, tavily: { configured: false }, github: { configured: false, webhookSecret: false, autoInvestigate: false }, runner: { backend: 'docker', ok: true, detail: 'Docker', nodeImage: 'node', mavenImage: 'maven', cpus: '1', memory: '1g' }, replays: {}, queue: 0 },
  '/api/overview': { totals: { investigations: 1, experiments: 4, executedRuns: 17, validatedFixes: 1, patchesTotal: 1 }, byClassification: { flaky_test: 1 }, byVerdict: { confirmed: 1 }, byStatus: { completed: 1 }, bySource: { demo: 1 }, recent: [inv], repositories: [] },
  '/api/scenarios': [{ id: 'flaky-jest', title: 'Flaky Jest test in checkout-service', summary: 's', repository: 'alibi-demo/checkout-service', framework: 'jest', job: 'test', replayRecordedAt: null }],
  '/api/investigations': [inv],
  [`/api/investigations/${inv.id}`]: bundle,
  '/api/settings': { repeatDefault: 10, defaultMode: 'auto', autoInvestigate: false, readOnly: false, env: { modelOverrides: {}, maxModelCalls: 8, maxLogChars: 120000, runnerTimeoutSec: 180 } },
  '/api/webhooks/deliveries': [],
  '/api/repositories': [],
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.split('?')[0];
    if (init?.method === 'POST' && path === '/api/investigations/demo') return new Response(JSON.stringify(inv), { status: 202 });
    if (init?.method === 'POST' && path === '/api/patches/patch_1/validate') return new Response(JSON.stringify({ ...bundle.patches[0], status: 'validating' }), { status: 202 });
    const body = routes[path];
    return new Response(JSON.stringify(body ?? { error: 'Not found' }), { status: body ? 200 : 404 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

const renderAt = (path: string) => render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);

describe('dashboard', () => {
  it('renders real overview totals', async () => {
    renderAt('/overview');
    expect(await screen.findByText('17 sandboxed test runs')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Overview' })).toBeInTheDocument();
  });

  it('navigates between every primary section', async () => {
    renderAt('/overview');
    const nav = screen.getByRole('navigation', { name: 'Main' });
    fireEvent.click(within(nav).getByText('Investigations'));
    expect(await screen.findByRole('heading', { name: 'Investigations' })).toBeInTheDocument();
    fireEvent.click(within(nav).getByText('Integrations'));
    expect(await screen.findByRole('heading', { name: 'Integrations' })).toBeInTheDocument();
    fireEvent.click(within(nav).getByText('Settings'));
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
  });

  it('shows verdict, confidence basis, strongest support, hypotheses and the replay label', async () => {
    renderAt(`/investigations/${inv.id}`);
    expect(await screen.findByText('Flaky test', { selector: '.cls' })).toBeInTheDocument();
    expect(screen.getAllByText(/95% CI 6%–51%/).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Replay').length).toBeGreaterThan(0);
    expect(screen.getAllByText('The test depends on random jitter.').length).toBeGreaterThan(0);
    expect(screen.getByText('Strongest support')).toBeInTheDocument();
    expect(screen.getByText('How the verdict evolved')).toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: '2 passed, 1 failed of 3 planned runs' }).length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Investigation progress')).toHaveTextContent('Evidence');
  });

  it('distinguishes a validated fix and can re-run its validation', async () => {
    renderAt(`/investigations/${inv.id}`);
    // Scoped to the fix card: the Evidence Path also labels this fix as validated.
    const card = await screen.findByRole('article', { name: /Quarantine "delivers notifications/ });
    expect(within(card).getByText('Validated fix')).toBeInTheDocument();
    expect(screen.getByText(/Remaining risks/i)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /Patch diff, 1 additions and 1 deletions/ })).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Re-validate/ }));
    });
    expect(vi.mocked(fetch).mock.calls.some(([u, i]) => u === '/api/patches/patch_1/validate' && (i as RequestInit)?.method === 'POST')).toBe(true);
  });

  it('renders the evidence ledger with phases, kinds, provenance, and filters', async () => {
    renderAt(`/investigations/${inv.id}/ledger`);
    expect(await screen.findByText('CI run used Jest seed 1849273600')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'CI log L55' })).toHaveAttribute('href', `/investigations/${inv.id}/log?line=55&to=55`);
    expect(screen.getByRole('link', { name: /Run the failing test 10×/ })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Failure evidence' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Experiment result/ }));
    await waitFor(() => expect(screen.queryByText('CI run used Jest seed 1849273600')).not.toBeInTheDocument());
    expect(screen.getByText('Repeat: 1/3 failed')).toBeInTheDocument();
  });

  it('shows per-attempt results on the experiment page', async () => {
    renderAt(`/investigations/${inv.id}/experiments/exp_rep`);
    expect(await screen.findByText('131074')).toBeInTheDocument();
    expect(screen.getByText('1 of 3 runs failed')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Isolation/ })).toBeInTheDocument();
    // the failed run is selected by default and its output is shown as text
    expect(screen.getByLabelText('Run #2')).toHaveTextContent('FAIL test/retryQueue.test.js');
    fireEvent.click(screen.getByRole('button', { name: 'Show output of run 1' }));
    expect(screen.getByLabelText('Run #1')).toBeInTheDocument();
  });

  it('starts a sample investigation from the modal', async () => {
    renderAt('/settings');
    fireEvent.click(screen.getByRole('button', { name: /Run sample investigation/ }));
    const dialog = await screen.findByRole('dialog');
    await act(async () => {
      fireEvent.click(await within(dialog).findByRole('button', { name: /Investigate Flaky Jest test/ }));
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(vi.mocked(fetch).mock.calls.some(([u, i]) => u === '/api/investigations/demo' && (i as RequestInit)?.method === 'POST')).toBe(true);
  });

  it('toggles the compact navigation drawer', async () => {
    renderAt('/overview');
    const btn = screen.getByRole('button', { name: 'Open navigation' });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
  });

  it('serves the public landing page at / and the app shell everywhere else', async () => {
    vi.stubGlobal('scrollTo', vi.fn()); // jsdom does not implement scrolling
    renderAt('/');
    expect(screen.getByRole('heading', { level: 1, name: "Don't just explain the failure. Prove it." })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Main' })).not.toBeInTheDocument();
    cleanup();
    renderAt('/no-such-page');
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to overview' })).toHaveAttribute('href', '/overview');
  });

  it('shows a clear error state when the API fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Investigation not found' }), { status: 404 })));
    renderAt('/investigations/inv_missing');
    expect(await screen.findByRole('alert')).toHaveTextContent('Investigation not found');
  });
});
