/**
 * Captures every main screen at several viewport sizes and reports horizontal
 * overflow. Requires a running server (default http://127.0.0.1:8787).
 *   node scripts/screenshots.mjs <outDir> [baseUrl] [--only=1440,390]
 */
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const out = process.argv[2] ?? 'screenshots';
const base = process.argv.find((a) => a.startsWith('http')) ?? 'http://127.0.0.1:8787';
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7).split(',').map(Number);
const sizes = [[1440, 900], [1280, 800], [1024, 768], [768, 1024], [390, 844]].filter(([w]) => !only || only.includes(w));
mkdirSync(out, { recursive: true });

const list = await (await fetch(`${base}/api/investigations`)).json();
const pick = (s) => list.find((i) => i.scenarioId === s && i.status !== 'failed') ?? list[0];
const flaky = pick('flaky-jest');
const maven = pick('maven-dependency');
const bundle = flaky ? await (await fetch(`${base}/api/investigations/${flaky.id}`)).json() : null;
const repeat = bundle?.experiments.find((e) => e.kind === 'repeat') ?? bundle?.experiments[0];
const pages = [
  ['overview', '/'],
  ['investigations', '/investigations'],
  ...(maven ? [['detail-maven', `/investigations/${maven.id}`]] : []),
  ...(flaky ? [['detail-flaky', `/investigations/${flaky.id}`], ['ledger', `/investigations/${flaky.id}/ledger`]] : []),
  ...(repeat ? [['experiment', `/investigations/${flaky.id}/experiments/${repeat.id}`]] : []),
  ['integrations', '/integrations'],
  ['settings', '/settings'],
];

const browser = await chromium.launch();
const problems = [];
for (const [w, h] of sizes) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  page.on('pageerror', (e) => problems.push(`${w} pageerror ${e}`));
  page.on('console', (m) => m.type() === 'error' && problems.push(`${w} console ${m.text()}`));
  for (const [name, path] of pages) {
    await page.goto(base + path, { waitUntil: 'networkidle' });
    await page.waitForTimeout(150);
    const overflow = await page.evaluate(() => {
      const doc = document.documentElement;
      if (doc.scrollWidth <= doc.clientWidth + 1) return null;
      const offenders = [...document.querySelectorAll('body *')]
        .filter((el) => el.getBoundingClientRect().right > doc.clientWidth + 1 && !el.closest('.scroll-x, .terminal, .diff, .table-wrap, .logview'))
        .slice(0, 4)
        .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}`);
      return `${doc.scrollWidth}>${doc.clientWidth} ${offenders.join(' ')}`;
    });
    if (overflow) problems.push(`${w} ${name}: horizontal overflow ${overflow}`);
    await page.screenshot({ path: `${out}/${name}-${w}.png`, fullPage: true });
  }
  await page.close();
}
await browser.close();
console.log(problems.length ? problems.join('\n') : 'no overflow or console errors');
