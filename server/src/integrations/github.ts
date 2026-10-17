import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { redactSecrets } from '../analysis/redact.js';

export class GitHubError extends Error {
  constructor(message: string, readonly status?: number, readonly hint?: string) {
    super(message);
  }
}

export interface RunRef {
  owner: string;
  repo: string;
  runId: number;
  jobId?: number;
}

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

export function parseRunUrl(url: string): RunRef | null {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)(?:\/job\/(\d+))?(?:\/attempts\/\d+)?\/?(?:[?#].*)?$/.exec(url.trim());
  if (!m || !NAME.test(m[1]) || !NAME.test(m[2])) return null;
  return { owner: m[1], repo: m[2], runId: Number(m[3]), jobId: m[4] ? Number(m[4]) : undefined };
}

/** Verifies X-Hub-Signature-256 using a constant-time comparison. */
export function verifyWebhookSignature(secret: string, payload: Buffer | string, signature: string | undefined): boolean {
  if (!signature || !signature.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`);
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

function hintFor(status: number, path: string): string | undefined {
  if (status === 401) return 'The GitHub token is missing or invalid. Set GITHUB_TOKEN to a token with read access to the repository.';
  if (status === 403) return 'Access denied or rate limited. A fine-grained token needs "Actions: read" and "Contents: read" (plus "Pull requests: write" and "Contents: write" only for draft PRs).';
  if (status === 404) return path.includes('/logs') ? 'Logs are unavailable (expired, deleted, or the token lacks Actions: read).' : 'Not found, or the token cannot see this repository.';
  if (status === 410) return 'Logs have expired for this run.';
  return undefined;
}

export class GitHubClient {
  constructor(
    private readonly token = config.github.token,
    private readonly apiUrl = config.github.apiUrl,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get configured(): boolean {
    return Boolean(this.token);
  }

  private headers(accept = 'application/vnd.github+json'): Record<string, string> {
    const h: Record<string, string> = { Accept: accept, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'alibi-ci-forensics' };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  private async raw(path: string, init: RequestInit & { accept?: string } = {}): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30_000);
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.apiUrl}${path}`, {
          ...init,
          headers: { ...this.headers(init.accept), ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
          redirect: 'manual',
          signal: ctrl.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        if (attempt >= 3) throw new GitHubError(`GitHub request failed: ${(err as Error).message}`);
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      clearTimeout(timer);
      const rateLimited = res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0');
      if ((res.status >= 500 || rateLimited) && attempt < 3) {
        const ra = Number(res.headers.get('retry-after'));
        await new Promise((r) => setTimeout(r, Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 15_000) : 1000 * attempt));
        continue;
      }
      return res;
    }
  }

  async json<T = any>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.raw(path, init);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      throw new GitHubError(`GitHub ${res.status} on ${path}: ${body.message ?? res.statusText}`, res.status, hintFor(res.status, path));
    }
    return (await res.json()) as T;
  }

  async text(path: string, accept: string): Promise<string> {
    const res = await this.raw(path, { accept });
    if (!res.ok) throw new GitHubError(`GitHub ${res.status} on ${path}`, res.status, hintFor(res.status, path));
    return res.text();
  }

  async whoami(): Promise<{ login: string; scopes: string | null }> {
    const res = await this.raw('/user');
    if (!res.ok) throw new GitHubError(`GitHub ${res.status} on /user`, res.status, hintFor(res.status, '/user'));
    const body = (await res.json()) as { login: string };
    return { login: body.login, scopes: res.headers.get('x-oauth-scopes') };
  }

  getRun(r: RunRef) {
    return this.json<any>(`/repos/${r.owner}/${r.repo}/actions/runs/${r.runId}`);
  }

  async listJobs(r: RunRef): Promise<any[]> {
    const body = await this.json<{ jobs: any[] }>(`/repos/${r.owner}/${r.repo}/actions/runs/${r.runId}/jobs?filter=latest&per_page=100`);
    return body.jobs ?? [];
  }

  async listArtifacts(r: RunRef): Promise<Array<{ name: string; sizeInBytes: number; expired: boolean }>> {
    const body = await this.json<{ artifacts: any[] }>(`/repos/${r.owner}/${r.repo}/actions/runs/${r.runId}/artifacts?per_page=50`);
    return (body.artifacts ?? []).map((a) => ({ name: a.name, sizeInBytes: a.size_in_bytes, expired: a.expired }));
  }

  /** Downloads a job's plain-text log. Follows the signed redirect without forwarding the token. */
  async jobLog(owner: string, repo: string, jobId: number, maxBytes = 8 * 1024 * 1024): Promise<string> {
    const path = `/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`;
    const res = await this.raw(path);
    let text: string;
    if (res.status === 302 || res.status === 301) {
      const loc = res.headers.get('location');
      if (!loc) throw new GitHubError('Log redirect without location', res.status);
      const logRes = await this.fetchImpl(loc);
      if (!logRes.ok) throw new GitHubError(`Log download failed: ${logRes.status}`, logRes.status, hintFor(logRes.status, path));
      text = await logRes.text();
    } else if (res.ok) {
      text = await res.text();
    } else {
      throw new GitHubError(`GitHub ${res.status} on ${path}`, res.status, hintFor(res.status, path));
    }
    if (text.length > maxBytes) text = `[log truncated to last ${maxBytes} bytes]\n${text.slice(-maxBytes)}`;
    return redactSecrets(text).text;
  }

  getCommit(owner: string, repo: string, sha: string) {
    return this.json<any>(`/repos/${owner}/${repo}/commits/${sha}`);
  }

  compareDiff(owner: string, repo: string, base: string, head: string): Promise<string> {
    return this.text(`/repos/${owner}/${repo}/compare/${base}...${head}`, 'application/vnd.github.diff');
  }

  async pullsForCommit(owner: string, repo: string, sha: string): Promise<Array<{ number: number; html_url: string; title: string }>> {
    try {
      return await this.json<any[]>(`/repos/${owner}/${repo}/commits/${sha}/pulls`);
    } catch {
      return [];
    }
  }

  async getRepo(owner: string, repo: string) {
    return this.json<any>(`/repos/${owner}/${repo}`);
  }

  /**
   * Creates a branch with the given file contents on top of `baseSha` and opens
   * a draft PR. Uses the Git Data API so no credentials touch a workspace.
   */
  async createDraftPr(args: {
    owner: string;
    repo: string;
    baseBranch: string;
    baseSha: string;
    branch: string;
    title: string;
    body: string;
    files: Array<{ path: string; content: string }>;
  }): Promise<{ url: string; number: number }> {
    const { owner, repo } = args;
    const baseCommit = await this.json<any>(`/repos/${owner}/${repo}/git/commits/${args.baseSha}`);
    const tree = await this.json<any>(`/repos/${owner}/${repo}/git/trees`, {
      method: 'POST',
      body: JSON.stringify({
        base_tree: baseCommit.tree.sha,
        tree: args.files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })),
      }),
    });
    const commit = await this.json<any>(`/repos/${owner}/${repo}/git/commits`, {
      method: 'POST',
      body: JSON.stringify({ message: args.title, tree: tree.sha, parents: [args.baseSha] }),
    });
    await this.json(`/repos/${owner}/${repo}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${args.branch}`, sha: commit.sha }),
    });
    const pr = await this.json<any>(`/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      body: JSON.stringify({ title: args.title, head: args.branch, base: args.baseBranch, body: args.body, draft: true }),
    });
    return { url: pr.html_url, number: pr.number };
  }
}
