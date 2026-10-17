import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCENARIO_DIR } from '../scenarios/registry.js';
import { analyzeDiff, dependencyChanges } from './diff.js';
import { extractFacts, selectExcerpts, splitLines, verifyQuote } from './logs.js';
import { redactSecrets } from './redact.js';
import { wilson } from './stats.js';

const log = (id: string) => readFileSync(join(SCENARIO_DIR, id, 'ci-log.txt'), 'utf8');

describe('failure-signature parsing', () => {
  it('extracts the flaky Jest failure, file, assertion, and CI seed', () => {
    const f = extractFacts(log('flaky-jest'));
    expect(f.framework).toBe('jest');
    expect(f.failingTests).toEqual([{ name: 'planDeliveries delivers notifications in submission order', file: 'test/retryQueue.test.js' }]);
    expect(f.jestSeed).toBe(1849273600);
    expect(f.exitCode).toBe(1);
    expect(f.signature).toContain('test/retryQueue.test.js › planDeliveries delivers notifications in submission order');
    expect(f.signature).toContain('toEqual');
  });

  it('extracts both failing tests of the code regression', () => {
    const f = extractFacts(log('code-regression'));
    expect(f.failingTests.map((t) => t.name)).toEqual([
      'discountRate applies 10% at exactly the $100.00 threshold',
      'discountRate applies 15% from $250',
    ]);
    expect(f.signature).toContain('(+1 more)');
  });

  it('extracts the Maven compile error with symbol and location', () => {
    const f = extractFacts(log('maven-dependency'));
    expect(f.framework).toBe('maven');
    expect(f.compileErrors[0]).toMatchObject({
      file: 'src/main/java/com/example/inventory/InventoryItem.java',
      line: 50,
      message: 'cannot find symbol',
      symbol: 'method toStringHelper(com.example.inventory.InventoryItem)',
      location: 'class com.google.common.base.Objects',
    });
    expect(f.downloads.some((d) => d.artifact === 'guava' && d.version === '21.0')).toBe(true);
    expect(f.signature).toBe(
      'maven: compilation error at InventoryItem.java:50 — cannot find symbol, symbol method toStringHelper(com.example.inventory.InventoryItem), in class com.google.common.base.Objects',
    );
  });

  it('extracts Mocha failures from a real-world-shaped log', () => {
    const mocha = [
      '  1180 passing (3s)',
      '  2 pending',
      '  1 failing',
      '',
      '  1) node:http pass-through',
      '       res',
      '         should support res.writeEarlyHints():',
      '',
      '      Uncaught AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
      '      at IncomingMessage.<anonymous> (test/http.native.js:172:20)',
      '      at IncomingMessage.emit (node:events:525:35)',
      '##[error]Process completed with exit code 1.',
    ].join('\n');
    const f = extractFacts(mocha);
    expect(f.framework).toBe('mocha');
    expect(f.failingTests[0].name).toBe('node:http pass-through res should support res.writeEarlyHints()');
    expect(f.failingFiles).toEqual(['test/http.native.js']);
    expect(f.signature).toContain('Uncaught AssertionError');
  });

  it('returns a generic signature for logs without recognizable failures', () => {
    expect(extractFacts('hello\nworld').signature).toBe('unknown: build failed without a recognizable test failure');
  });
});

describe('long-log context selection', () => {
  it('stays within the character budget and keeps the failure region', () => {
    const noise = Array.from({ length: 50_000 }, (_, i) => `2026-10-15T00:00:00.0000000Z [INFO] Downloading artifact ${i}`).join('\n');
    const big = `${noise}\n${log('maven-dependency')}`;
    const ex = selectExcerpts(big, 4000);
    const total = ex.reduce((n, e) => n + e.text.length, 0);
    expect(total).toBeLessThanOrEqual(4000);
    expect(ex.some((e) => e.text.includes('cannot find symbol'))).toBe(true);
    expect(ex.every((e) => e.startLine > 0 && e.endLine >= e.startLine)).toBe(true);
    expect(splitLines(big).length).toBeGreaterThan(50_000);
  });
});

describe('quote verification (evidence provenance)', () => {
  const text = log('flaky-jest');
  it('verifies a real quote and corrects a nearby line number', () => {
    const lines = splitLines(text);
    const idx = lines.findIndex((l) => l.includes('Seed:'));
    const v = verifyQuote(text, 'Seed:        1849273600', idx + 3);
    expect(v).toEqual({ verified: true, line: idx + 1 });
  });
  it('rejects a fabricated quote', () => {
    expect(verifyQuote(text, 'ECONNRESET while contacting registry.npmjs.org', 10).verified).toBe(false);
  });
});

describe('secret redaction', () => {
  it('redacts tokens, credentials in URLs, and key=value secrets', () => {
    const gh = `ghp_${'a1B2'.repeat(9)}`;
    const npm = `npm_${'Zx9'.repeat(12)}`;
    const input = [`token ${gh}`, `//registry.npmjs.org/:_authToken=${npm}`, 'https://bot:hunter22@example.com/repo.git', 'DATABASE_PASSWORD=supersecret1', 'GITHUB_TOKEN: ***'].join('\n');
    const { text, count } = redactSecrets(input);
    expect(text).not.toContain(gh);
    expect(text).not.toContain(npm);
    expect(text).not.toContain('hunter22');
    expect(text).not.toContain('supersecret1');
    expect(text).toContain('GITHUB_TOKEN: ***');
    expect(count).toBeGreaterThanOrEqual(4);
  });

  it('regression (QA F1 probes): redacts Google API keys, Stripe keys, and Azure storage account keys', () => {
    const google = `AI${'za'}Sy${'Q1w2E3r4'.repeat(4)}x`;
    const stripeLive = `sk_${'live'}_${'4eC39HqLyjWDarjtT1zdp7dc'}`;
    const stripeRestricted = `rk_${'test'}_${'51Hq0aBcDeFgHiJkLmNoPq'}`;
    const azureKey = `${'Zm9vYmFy'.repeat(8)}==`;
    const input = [`maps key ${google}`, `charging with ${stripeLive}`, `restricted ${stripeRestricted}`, `DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=${azureKey};EndpointSuffix=core.windows.net`].join('\n');
    const { text, count } = redactSecrets(input);
    for (const s of [google, stripeLive, stripeRestricted, azureKey]) expect(text).not.toContain(s);
    expect(text).toContain('AccountName=acct');
    expect(text).toContain('AccountKey=[REDACTED]');
    expect(count).toBe(4);
  });

  it('regression (QA F1 count): counts each secret once and finds nothing on a second pass', () => {
    const gh = `ghp_${'a1B2'.repeat(9)}`;
    const input = [`token ${gh}`, `curl -H "Authorization: Bearer ${'Zz9'.repeat(8)}"`, 'DEPLOY_SECRET="hunter2hunter2"'].join('\n');
    const first = redactSecrets(input);
    expect(first.count).toBe(3);
    expect(redactSecrets(first.text).count).toBe(0);
  });
});

describe('diff analysis', () => {
  it('detects a Maven property version bump with exact lines', () => {
    const diff = [
      'diff --git a/pom.xml b/pom.xml',
      '--- a/pom.xml',
      '+++ b/pom.xml',
      '@@ -12,7 +12,7 @@',
      '-    <guava.version>20.0</guava.version>',
      '+    <guava.version>21.0</guava.version>',
    ].join('\n');
    expect(dependencyChanges(diff)).toEqual([
      { ecosystem: 'maven', name: 'guava', from: '20.0', to: '21.0', file: 'pom.xml', removedLine: '    <guava.version>20.0</guava.version>', addedLine: '    <guava.version>21.0</guava.version>' },
    ]);
  });
  it('detects npm dependency changes and docs-only commits', () => {
    const diff = ['diff --git a/package.json b/package.json', '-    "lodash": "4.17.20",', '+    "lodash": "4.17.21",'].join('\n');
    expect(dependencyChanges(diff)[0]).toMatchObject({ ecosystem: 'npm', name: 'lodash', from: '4.17.20', to: '4.17.21' });
    expect(analyzeDiff('', '3\t0\tREADME.md\n').onlyDocs).toBe(true);
    expect(analyzeDiff('', '3\t0\tsrc/a.js\n').onlyDocs).toBe(false);
  });
});

describe('flake-rate statistics', () => {
  it('computes a Wilson interval that contains the observed rate', () => {
    const w = wilson(2, 10);
    expect(w.rate).toBeCloseTo(0.2);
    expect(w.low).toBeCloseTo(0.0567, 3);
    expect(w.high).toBeCloseTo(0.5098, 3);
  });
  it('handles extremes and empty samples', () => {
    expect(wilson(0, 10).low).toBe(0);
    expect(wilson(10, 10).high).toBe(1);
    expect(wilson(0, 0)).toEqual({ rate: 0, low: 0, high: 1, n: 0 });
  });
});
