import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { GitHubClient, parseRunUrl, verifyWebhookSignature } from './github.js';
import { isOfficialSource, tavilySearch, TavilyError } from './tavily.js';

describe('Tavily', () => {
  const key = config.tavily.apiKey;
  afterEach(() => {
    config.tavily.apiKey = key;
  });

  it('fails clearly without a key', async () => {
    config.tavily.apiKey = undefined;
    await expect(tavilySearch('x')).rejects.toBeInstanceOf(TavilyError);
  });

  it('sends a bearer-authenticated search and maps results', async () => {
    config.tavily.apiKey = 'tvly-test';
    let seen: any;
    const impl = (async (url: string, init: RequestInit) => {
      seen = { url, headers: init.headers, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ query: 'q', results: [{ title: 'Guava 21.0 release notes', url: 'https://github.com/google/guava/releases/tag/v21.0', content: 'Objects.toStringHelper removed', score: 0.9 }], response_time: '0.8', request_id: 'r1' }), { status: 200 });
    }) as unknown as typeof fetch;
    const res = await tavilySearch('guava 21 toStringHelper', { maxResults: 3 }, impl);
    expect(seen.url).toBe('https://api.tavily.com/search');
    expect(seen.headers.Authorization).toBe('Bearer tvly-test');
    expect(seen.body).toMatchObject({ query: 'guava 21 toStringHelper', max_results: 3, include_answer: false });
    expect(res.results[0]).toMatchObject({ title: 'Guava 21.0 release notes', score: 0.9 });
    expect(res.requestId).toBe('r1');
  });

  it('does not retry client errors', async () => {
    config.tavily.apiKey = 'tvly-test';
    let n = 0;
    const impl = (async () => {
      n++;
      return new Response(JSON.stringify({ detail: { error: 'Unauthorized' } }), { status: 401 });
    }) as unknown as typeof fetch;
    await expect(tavilySearch('q', {}, impl)).rejects.toThrow(/401/);
    expect(n).toBe(1);
  });

  it('marks only official domains and implicated project repos as primary sources', () => {
    expect(isOfficialSource('https://www.githubstatus.com/incidents/abc')).toBe(true);
    expect(isOfficialSource('https://github.com/google/guava/releases/tag/v21.0', ['guava'])).toBe(true);
    expect(isOfficialSource('https://github.com/someone/blog/issues/1', ['guava'])).toBe(false);
    expect(isOfficialSource('https://stackoverflow.com/q/1')).toBe(false);
  });
});

describe('GitHub', () => {
  it('parses run URLs and rejects others', () => {
    expect(parseRunUrl('https://github.com/acme/api/actions/runs/123/job/456')).toEqual({ owner: 'acme', repo: 'api', runId: 123, jobId: 456 });
    expect(parseRunUrl('https://github.com/acme/api/actions/runs/123')).toMatchObject({ runId: 123 });
    expect(parseRunUrl('https://evil.com/acme/api/actions/runs/1')).toBeNull();
    expect(parseRunUrl('https://github.com/acme/api/pull/1')).toBeNull();
  });

  it('verifies webhook signatures in constant time', () => {
    const body = Buffer.from('{"a":1}');
    const sig = `sha256=${createHmac('sha256', 's3cret').update(body).digest('hex')}`;
    expect(verifyWebhookSignature('s3cret', body, sig)).toBe(true);
    expect(verifyWebhookSignature('wrong', body, sig)).toBe(false);
    expect(verifyWebhookSignature('s3cret', body, undefined)).toBe(false);
    expect(verifyWebhookSignature('s3cret', body, 'sha256=00')).toBe(false);
  });

  it('downloads logs via the signed redirect without forwarding the token, and redacts them', async () => {
    const seen: Array<{ url: string; auth?: string }> = [];
    const impl = (async (url: string, init?: RequestInit) => {
      seen.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
      if (url.includes('/actions/jobs/9/logs')) return new Response(null, { status: 302, headers: { location: 'https://logs.example/blob?sig=1' } });
      return new Response(`step\nexport TOKEN=ghp_${'q'.repeat(36)}\n`, { status: 200 });
    }) as unknown as typeof fetch;
    const gh = new GitHubClient('gho_secret', 'https://api.github.test', impl);
    const { text, redactions } = await gh.jobLog('o', 'r', 9);
    expect(seen[0].auth).toBe('Bearer gho_secret');
    expect(seen[1].url).toBe('https://logs.example/blob?sig=1');
    expect(seen[1].auth).toBeUndefined();
    expect(text).not.toContain('ghp_');
    // Regression (QA F1 count): the count of values removed at download is reported, not lost.
    expect(redactions).toBe(1);
  });

  it('turns permission errors into actionable hints', async () => {
    const impl = (async () => new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), { status: 403 })) as unknown as typeof fetch;
    const gh = new GitHubClient('t', 'https://api.github.test', impl);
    const err = await gh.getRun({ owner: 'o', repo: 'r', runId: 1 }).catch((e) => e);
    expect(err.status).toBe(403);
    expect(err.hint).toMatch(/Actions: read/);
  });
});
