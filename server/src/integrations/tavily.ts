import { config } from '../config.js';

export interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number | null;
  publishedDate: string | null;
}

export interface TavilyResponse {
  query: string;
  results: TavilyResult[];
  responseTimeSec: number | null;
  requestId: string | null;
}

export class TavilyError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/** Domains treated as primary sources (status pages, registries, official release notes). */
const OFFICIAL_DOMAINS = [
  /(^|\.)githubstatus\.com$/,
  /(^|\.)status\.npmjs\.org$/,
  /(^|\.)npmjs\.com$/,
  /(^|\.)nodejs\.org$/,
  /(^|\.)maven\.apache\.org$/,
  /(^|\.)central\.sonatype\.(com|org)$/,
  /(^|\.)status\.maven\.org$/,
  /(^|\.)guava\.dev$/,
  /(^|\.)jestjs\.io$/,
  /(^|\.)docs\.github\.com$/,
  /(^|\.)statuspage\.io$/,
  /^status\./,
];

export function isOfficialSource(url: string, hints: string[] = []): boolean {
  try {
    const u = new URL(url);
    if (OFFICIAL_DOMAINS.some((re) => re.test(u.hostname))) return true;
    // GitHub release notes / issues of a project named in the evidence.
    if (u.hostname === 'github.com' && /\/(releases|issues|pull|wiki|blob\/[^/]+\/CHANGELOG)/i.test(u.pathname)) {
      const repo = u.pathname.split('/')[2]?.toLowerCase() ?? '';
      return hints.some((h) => h && repo.includes(h.toLowerCase()));
    }
    return false;
  } catch {
    return false;
  }
}

export function tavilyConfigured(): boolean {
  return Boolean(config.tavily.apiKey);
}

export async function tavilySearch(
  query: string,
  opts: { maxResults?: number; includeDomains?: string[]; timeRange?: 'day' | 'week' | 'month' | 'year'; topic?: 'general' | 'news' } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<TavilyResponse> {
  if (!config.tavily.apiKey) throw new TavilyError('TAVILY_API_KEY is not configured');
  const body: Record<string, unknown> = {
    query: query.slice(0, 380),
    search_depth: 'basic',
    max_results: Math.min(opts.maxResults ?? 5, 10),
    topic: opts.topic ?? 'general',
    include_answer: false,
    include_raw_content: false,
    include_published_date: true,
  };
  if (opts.includeDomains?.length) {
    body.include_domains = opts.includeDomains;
    body.include_domains_mode = 'prefer';
  }
  if (opts.timeRange) body.time_range = opts.timeRange;

  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), config.tavily.timeoutMs);
    try {
      const res = await fetchImpl('https://api.tavily.com/search', {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.tavily.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const json = (await res.json().catch(() => ({}))) as any;
      if (res.ok) {
        return {
          query: json.query ?? query,
          results: (json.results ?? []).map((r: any) => ({
            title: String(r.title ?? r.url ?? 'Untitled'),
            url: String(r.url),
            content: String(r.content ?? '').slice(0, 2000),
            score: typeof r.score === 'number' ? r.score : null,
            publishedDate: r.published_date ?? null,
          })),
          responseTimeSec: typeof json.response_time === 'number' ? json.response_time : Number(json.response_time) || null,
          requestId: json.request_id ?? null,
        };
      }
      const msg = json?.detail?.error ?? json?.error ?? json?.message ?? `HTTP ${res.status}`;
      lastErr = new TavilyError(`Tavily ${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`, res.status);
      if (res.status !== 429 && res.status < 500) throw lastErr;
      const ra = Number(res.headers.get('retry-after'));
      await new Promise((r) => setTimeout(r, Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 10_000) : 800 * attempt));
    } catch (err) {
      if (err instanceof TavilyError && err.status && err.status !== 429 && err.status < 500) throw err;
      lastErr = (err as Error).name === 'AbortError' ? new TavilyError('Tavily request timed out') : (err as Error);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr ?? new TavilyError('Tavily request failed');
}
