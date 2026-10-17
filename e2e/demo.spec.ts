import { expect, test } from '@playwright/test';

test('a sample investigation runs end to end: hypotheses → sandbox experiments → validated fix → verdict', async ({ page }) => {
  await page.goto('/overview');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();

  await page.getByRole('button', { name: 'Investigate Discount boundary regression in pricing-engine' }).click();
  await expect(page).toHaveURL(/\/investigations\/inv_/);
  await expect(page.getByRole('heading', { name: 'alibi-demo/pricing-engine' })).toBeVisible();

  // Progress reflects persisted state, then completion (real containers run here).
  await expect(page.getByLabel('Investigation progress')).toBeVisible();
  await expect(page.locator('.inv-head .badge', { hasText: 'Completed' })).toBeVisible({ timeout: 240_000 });
  await expect(page.locator('.verdict-line')).toContainText('Code regression');
  await expect(page.locator('.verdict-line')).toContainText('Confirmed');
  // Ordinary runs may use Replay or Heuristic, but never live provider calls.
  if (process.env.ALIBI_E2E_LIVE !== '1') await expect(page.locator('.inv-head')).not.toContainText('Live Nemotron');
  await expect(page.getByText('Failure reproduced in a clean sandbox at the failing commit.').first()).toBeVisible();
  await expect(page.getByText(/Parent commit: 0\/3 runs failed/).first()).toBeVisible();
  await expect(page.getByText('Validated fix').first()).toBeVisible();
  await expect(page.getByText('How the verdict evolved')).toBeVisible();

  // Evidence ledger: grouped phases, experiment results with provenance, filters.
  await page.getByRole('link', { name: /Evidence ledger/ }).click();
  await expect(page.getByRole('region', { name: 'Experiments' })).toBeVisible();
  await expect(page.locator('.entry', { hasText: 'Reproduce the failure' }).first()).toBeVisible();
  await page.getByRole('button', { name: /Experiment result/ }).click();
  await expect(page).toHaveURL(/kind=experiment_result/);
  await expect(page.locator('.entry .e-kind', { hasText: 'Observed fact' })).toHaveCount(0);

  // Experiment detail shows per-run exit codes and the recorded isolation.
  await page.getByRole('link', { name: /^Experiments/ }).click();
  await page.getByRole('link', { name: 'Reproduce the failure' }).first().click();
  await expect(page.getByRole('heading', { name: 'Reproduce the failure' })).toBeVisible();
  await expect(page.locator('td.num.mono', { hasText: /^1$/ }).first()).toBeVisible();
  await expect(page.getByText('Disabled during test runs')).toBeVisible();
  await expect(page.getByLabel('Run #1')).toContainText('discountRate');

  // History search finds it.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Investigations' }).click();
  await page.getByLabel('Search investigations').fill('pricing');
  await expect(page.locator('a.repo', { hasText: 'alibi-demo/pricing-engine' }).first()).toBeVisible();
});

test('mobile navigation drawer opens and navigates', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/overview');
  const menu = page.getByRole('button', { name: 'Open navigation' });
  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Integrations' }).click();
  await expect(page.getByRole('heading', { name: 'Integrations', level: 1 })).toBeVisible();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  // Evidence Path stacks vertically on phones without widening the page.
  const list = await (await page.request.get('/api/investigations?status=completed')).json();
  if (list.length) {
    await page.goto(`/investigations/${list[0].id}`);
    await expect(page.getByRole('list', { name: 'Evidence path steps' })).toBeVisible();
    const pathOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(pathOverflow).toBeLessThanOrEqual(1);
  }
});

test('the public landing page links into the product without calling the API', async ({ page }) => {
  const api: string[] = [];
  page.on('request', (r) => new URL(r.url()).pathname.startsWith('/api/') && api.push(r.url()));
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: "Don't just explain the failure. Prove it." })).toBeVisible();
  await expect(page.locator('#sample').getByText('Sample investigation')).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(api).toEqual([]);
  await page.getByRole('link', { name: 'Explore the product' }).click();
  await expect(page).toHaveURL(/\/overview$/);
  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
});
