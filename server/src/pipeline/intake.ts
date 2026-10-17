import { config } from '../config.js';
import type { Store } from '../db/store.js';
import type { Framework, Investigation } from '../domain/types.js';
import { GitHubClient, GitHubError, type RunRef } from '../integrations/github.js';
import { buildDemoRepo } from '../scenarios/build.js';
import { getScenario } from '../scenarios/registry.js';
import { git } from '../runner/git.js';
import { freshInvestigation } from './investigate.js';
import type { InvestigationQueue } from './queue.js';

export type RequestedMode = Investigation['options']['requestedMode'];

export interface StartOptions {
  mode?: RequestedMode;
  repeat?: number;
}

export class IntakeError extends Error {
  constructor(message: string, readonly status = 400, readonly hint?: string) {
    super(message);
  }
}

function options(store: Store, opts: StartOptions): Investigation['options'] {
  const s = store.getSettings();
  const repeat = Number(opts.repeat ?? s.repeatDefault ?? config.runner.repeatDefault);
  return {
    repeat: Number.isFinite(repeat) ? Math.max(2, Math.min(Math.round(repeat), 30)) : config.runner.repeatDefault,
    requestedMode: (opts.mode ?? (s.defaultMode as RequestedMode | undefined) ?? 'auto') as RequestedMode,
  };
}

export async function startDemo(store: Store, queue: InvestigationQueue, scenarioId: string, opts: StartOptions = {}): Promise<Investigation> {
  const scenario = getScenario(scenarioId);
  if (!scenario) throw new IntakeError(`Unknown scenario "${scenarioId}"`, 404);
  const repo = await buildDemoRepo(scenario.id);
  const failing = repo.commits[repo.commits.length - 1];
  const parent = repo.commits[repo.commits.length - 2];
  const author = (await git(['log', '-1', '--format=%an', failing.sha], { cwd: repo.repoPath })).trim();
  const inv = freshInvestigation({
    source: 'demo',
    scenarioId: scenario.id,
    repository: scenario.repository,
    commitSha: failing.sha,
    parentSha: parent?.sha ?? null,
    branch: scenario.branch,
    workflow: scenario.workflow,
    job: scenario.job,
    commitMessage: failing.message,
    commitAuthor: author,
    framework: scenario.framework,
    options: options(store, opts),
  });
  store.createInvestigation(inv);
  queue.enqueue(inv.id);
  return inv;
}

async function detectFrameworkRemote(gh: GitHubClient, ref: RunRef, sha: string): Promise<Framework> {
  const exists = async (path: string) => {
    try {
      return await gh.json<any>(`/repos/${ref.owner}/${ref.repo}/contents/${path}?ref=${sha}`);
    } catch {
      return null;
    }
  };
  if (await exists('pom.xml')) return 'maven';
  const pkg = await exists('package.json');
  if (pkg?.content) {
    try {
      const json = JSON.parse(Buffer.from(pkg.content, 'base64').toString('utf8'));
      const deps = { ...json.dependencies, ...json.devDependencies };
      if (deps.jest || /\bjest\b/.test(json.scripts?.test ?? '')) return 'jest';
    } catch {
      // fall through
    }
  }
  return 'unknown';
}

/** Creates (or returns the existing) investigation for a failed GitHub Actions run. */
export async function startFromGitHubRun(
  store: Store,
  queue: InvestigationQueue,
  gh: GitHubClient,
  ref: RunRef,
  opts: StartOptions = {},
): Promise<{ investigation: Investigation; duplicate: boolean }> {
  let run: any;
  try {
    run = await gh.getRun(ref);
  } catch (err) {
    const e = err as GitHubError;
    throw new IntakeError(e.message, e.status === 404 ? 404 : 502, e.hint);
  }
  if (run.status !== 'completed') throw new IntakeError(`Run ${ref.runId} is still ${run.status}; investigate after it completes.`, 409);
  if (run.conclusion !== 'failure') throw new IntakeError(`Run ${ref.runId} concluded "${run.conclusion}", not "failure".`, 409);

  const dedupeKey = `gh:${ref.owner}/${ref.repo}:${ref.runId}:${run.run_attempt ?? 1}`;
  const existing = store.findByDedupeKey(dedupeKey);
  if (existing) return { investigation: existing, duplicate: true };

  const sha: string = run.head_sha;
  let parentSha: string | null = null;
  let commitMessage: string | null = run.head_commit?.message?.split('\n')[0] ?? null;
  let commitAuthor: string | null = run.head_commit?.author?.name ?? null;
  try {
    const commit = await gh.getCommit(ref.owner, ref.repo, sha);
    parentSha = commit.parents?.[0]?.sha ?? null;
    commitMessage ??= commit.commit?.message?.split('\n')[0] ?? null;
    commitAuthor ??= commit.commit?.author?.name ?? null;
  } catch {
    // parent remains unknown; recorded as a limitation during the run
  }
  let pr = run.pull_requests?.[0] ? { number: run.pull_requests[0].number, html_url: `https://github.com/${ref.owner}/${ref.repo}/pull/${run.pull_requests[0].number}` } : null;
  if (!pr) pr = (await gh.pullsForCommit(ref.owner, ref.repo, sha))[0] ?? null;

  const inv = freshInvestigation({
    source: 'github',
    repository: `${ref.owner}/${ref.repo}`,
    repoUrl: `https://github.com/${ref.owner}/${ref.repo}`,
    commitSha: sha,
    parentSha,
    branch: run.head_branch ?? null,
    workflow: run.name ?? null,
    job: ref.jobId ? String(ref.jobId) : null,
    runId: String(ref.runId),
    runUrl: run.html_url ?? null,
    prNumber: pr?.number ?? null,
    prUrl: pr?.html_url ?? null,
    commitMessage,
    commitAuthor,
    framework: await detectFrameworkRemote(gh, ref, sha),
    options: options(store, opts),
  });
  try {
    store.createInvestigation(inv, dedupeKey);
  } catch {
    const again = store.findByDedupeKey(dedupeKey);
    if (again) return { investigation: again, duplicate: true };
    throw new IntakeError('Could not create investigation', 500);
  }
  store.upsertRepository(inv.repository, { url: inv.repoUrl, lastRunId: ref.runId });
  queue.enqueue(inv.id);
  return { investigation: inv, duplicate: false };
}
