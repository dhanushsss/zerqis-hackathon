import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BRAND } from '../brand';
import { Docs } from './Docs';
import { Landing } from './Landing';

function Where() {
  const l = useLocation();
  return <output data-testid="where">{`${l.pathname}${l.hash}`}</output>;
}

const renderAt = (path = '/') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/docs" element={<Docs />} />
        <Route path="*" element={<p>app route</p>} />
      </Routes>
      <Where />
    </MemoryRouter>,
  );

const reducedMotion = (on: boolean) =>
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: on && q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {} }));

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
  vi.stubGlobal('scrollTo', vi.fn()); // jsdom does not implement scrolling
  reducedMotion(false);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const sample = () => screen.getByRole('region', { name: /pricing-engine/ });

describe('landing page', () => {
  it('shows the Zerqis brand, headline, and title, with no old brand', async () => {
    renderAt();
    expect(screen.getByRole('heading', { level: 1, name: BRAND.tagline })).toBeVisible();
    expect(screen.getAllByText('Zerqis').length).toBeGreaterThan(0);
    expect(document.title).toBe('Zerqis — Evidence-driven CI investigation');
    await screen.findByRole('region', { name: /pricing-engine/ });
    expect(document.body.textContent).not.toMatch(/alibi/i);
  });

  it('navigation points at real destinations', () => {
    renderAt();
    const nav = screen.getByRole('navigation', { name: 'Site' });
    expect(within(nav).getByRole('link', { name: 'Product' })).toHaveAttribute('href', '/#product');
    expect(within(nav).getByRole('link', { name: 'How it works' })).toHaveAttribute('href', '/#how');
    expect(within(nav).getByRole('link', { name: 'Use cases' })).toHaveAttribute('href', '/#use-cases');
    expect(within(nav).getByRole('link', { name: 'Documentation' })).toHaveAttribute('href', '/docs');
    for (const id of ['product', 'how', 'use-cases', 'sample', 'evidence', 'security']) expect(document.getElementById(id)).not.toBeNull();
    expect(screen.queryByRole('link', { name: /sign in/i })).toBeNull();
  });

  it('"Explore the product" opens the app overview; "Documentation" opens the guide', () => {
    renderAt();
    fireEvent.click(screen.getByRole('link', { name: /Explore the product/ }));
    expect(screen.getByTestId('where')).toHaveTextContent('/overview');
    cleanup();
    renderAt();
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Site' })).getByRole('link', { name: 'Documentation' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Zerqis product guide' })).toBeVisible();
  });

  it('the sample plays through each stage once, from recorded data, and can be paused', async () => {
    vi.useFakeTimers();
    renderAt();
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Pause sample' })).toBeEnabled());
    const current = () => within(sample()).getByRole('button', { current: 'step' }).textContent;
    expect(current()).toBe('Failure');
    expect(within(sample()).getByText(/discountRate applies 10% at exactly the \$100\.00 threshold/)).toBeVisible();

    act(() => vi.advanceTimersByTime(2600));
    expect(current()).toBe('Hypotheses');

    fireEvent.click(screen.getByRole('button', { name: 'Pause sample' }));
    act(() => vi.advanceTimersByTime(20_000));
    expect(current()).toBe('Hypotheses');

    fireEvent.click(screen.getByRole('button', { name: 'Play sample' }));
    for (let i = 0; i < 3; i++) act(() => vi.advanceTimersByTime(2600));
    expect(current()).toBe('Fix validation');
    expect(within(sample()).getAllByText('Validated').length).toBe(2);
    // Stops at the end instead of looping.
    act(() => vi.advanceTimersByTime(20_000));
    expect(current()).toBe('Fix validation');
    expect(screen.getByRole('button', { name: 'Replay sample' })).toBeVisible();
    expect(within(sample()).getByText(/Nothing runs and no model is called/)).toBeVisible();
  });

  it('stages can be chosen directly with the keyboard-focusable stage buttons', async () => {
    renderAt();
    await vi.waitFor(() => expect(within(sample()).getByRole('button', { name: 'Diagnosis' })).toBeEnabled());
    fireEvent.click(within(sample()).getByRole('button', { name: 'Diagnosis' }));
    expect(within(sample()).getByText('Code regression')).toBeVisible();
    expect(within(sample()).getByText('Confirmed')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Play sample' })).toBeVisible();
  });

  it('with reduced motion the outcome is shown immediately and nothing autoplays', async () => {
    reducedMotion(true);
    renderAt();
    await vi.waitFor(() => expect(within(sample()).getByRole('button', { current: 'step' })).toHaveTextContent('Fix validation'));
    expect(screen.getByRole('button', { name: 'Replay sample' })).toBeVisible();
    // Scroll-reveal is never armed, so no section starts hidden.
    expect(document.querySelector('.reveal-on')).toBeNull();
  });

  it('the evidence section shows recorded ledger records, the validated diff, and real test output', async () => {
    renderAt();
    const ev = screen.getByRole('region', { name: 'See the evidence, not just the explanation.' });
    const ledger = await within(ev).findByRole('figure', { name: 'Evidence ledger' });
    for (const label of ['Failure detected', 'Hypothesis to test', 'Parent commit comparison', 'Fix validated', 'Diagnosis']) {
      expect(within(ledger).getByText(label)).toBeVisible();
    }
    // Each row names its real ledger sequence number and provenance.
    expect(within(ledger).getAllByText(/^#\d+ · /).length).toBeGreaterThanOrEqual(5);
    expect(within(ledger).getByRole('region', { name: /Patch diff/ })).toHaveTextContent('subtotalCents >= t.minCents');
    expect(within(ledger).getByText(/Tests:\s+2 failed, 3 passed, 5 total/)).toBeVisible();
  });

  it('explains every diagnosis and fix outcome', () => {
    renderAt();
    const ev = screen.getByRole('region', { name: 'See the evidence, not just the explanation.' });
    for (const label of ['Cause confirmed', 'Cause probable', 'Cause inconclusive', 'Diagnosis blocked', 'Fix verified', 'Fixes rejected']) {
      expect(within(ev).getByText(label)).toBeVisible();
    }
  });

  it('validation separates targeted runs from the full suite, shows a rejected fix, and makes no proof claim', async () => {
    renderAt();
    const sec = screen.getByRole('region', { name: 'Catch the fixes that only look correct.' });
    await within(sec).findByText('Full test suite with the fix applied');
    expect(within(sec).getAllByText('Targeted runs of the failing tests')).toHaveLength(2);
    expect(within(sec).getByText(/7\/7 tests passed/)).toBeVisible();
    expect(within(sec).getByText('Validated')).toBeVisible();
    expect(within(sec).getByText('Rejected')).toBeVisible();
    expect(within(sec).getByText(/3 runs, 3 failed/)).toBeVisible();
    expect(within(sec).getByText(/not proof that it is correct in every situation/)).toBeVisible();
  });

  it('lists only real integrations and distinguishes their roles', () => {
    renderAt();
    const strip = screen.getByRole('region', { name: 'Works with' });
    for (const [name, role] of [['GitHub Actions', 'CI runs, logs, webhooks'], ['Jest', 'Experiments · JS and TypeScript'], ['Maven', 'Experiments · Java'], ['pytest', 'Experiments · Python'], ['Go', 'Experiments · Go modules']]) {
      expect(within(strip).getByText(name)).toBeVisible();
      expect(within(strip).getByText(role)).toBeVisible();
    }
    expect(strip.textContent).not.toMatch(/GitLab|Jenkins|CircleCI/);
    expect(within(strip).getByText(/verified on controlled test repositories only/)).toBeVisible();
  });

  it('separates current security controls from what is not available, without certification claims', () => {
    renderAt();
    const sec = screen.getByRole('region', { name: 'Built for controlled investigation.' });
    expect(within(sec).getByText(/networking disabled/)).toBeVisible();
    expect(within(sec).getByText(/No user accounts or authentication/)).toBeVisible();
    expect(within(sec).getByText('No compliance certifications.')).toBeVisible();
    expect(document.body.textContent).not.toMatch(/SOC ?2 certified|enterprise-ready|fully autonomous/i);
  });

  it('has exactly one "Explore the product" link, so browser tests can target it unambiguously', () => {
    renderAt();
    expect(screen.getAllByRole('link', { name: /Explore the product/ })).toHaveLength(1);
  });

  it('never calls the API', async () => {
    renderAt();
    await screen.findByRole('figure', { name: 'Evidence ledger' });
    await screen.findByText('Full test suite with the fix applied');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('mobile menu opens, lists the same destinations, and closes on Escape', () => {
    renderAt();
    const btn = screen.getByRole('button', { name: 'Open site menu' });
    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    const menu = screen.getByRole('navigation', { name: 'Site menu' });
    expect(within(menu).getByRole('link', { name: 'Documentation' })).toHaveAttribute('href', '/docs');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
  });
});
