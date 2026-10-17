import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { git } from '../runner/git.js';
import { getScenario, listScenarios, SCENARIO_DIR } from './registry.js';

export interface BuiltRepo {
  id: string;
  repoPath: string;
  commits: Array<{ sha: string; message: string }>;
}

export function demoRepoPath(id: string): string {
  return join(config.dataDir, 'demo-repos', id);
}

function parseAuthor(author: string): { name: string; email: string } {
  const m = /^(.*?)\s*<([^>]+)>$/.exec(author);
  return m ? { name: m[1], email: m[2] } : { name: author, email: 'unknown@example.dev' };
}

/** Builds (or reuses) a scenario's git repository with reproducible commit SHAs. */
export async function buildDemoRepo(id: string, { force = false } = {}): Promise<BuiltRepo> {
  const scenario = getScenario(id);
  if (!scenario) throw new Error(`Unknown scenario ${id}`);
  const repoPath = demoRepoPath(id);

  if (!force && existsSync(join(repoPath, '.git'))) {
    const log = await git(['log', '--reverse', '--format=%H%x09%s'], { cwd: repoPath });
    const commits = log.trim().split('\n').map((l) => {
      const [sha, ...rest] = l.split('\t');
      return { sha, message: rest.join('\t') };
    });
    if (commits.length === scenario.commits.length) return { id, repoPath, commits };
  }

  rmSync(repoPath, { recursive: true, force: true });
  mkdirSync(repoPath, { recursive: true });
  await git(['init', '-q', '-b', scenario.branch], { cwd: repoPath });

  const commits: BuiltRepo['commits'] = [];
  for (const c of scenario.commits) {
    cpSync(join(SCENARIO_DIR, id, 'commits', c.dir), repoPath, { recursive: true });
    await git(['add', '-A'], { cwd: repoPath });
    const who = parseAuthor(c.author);
    const env = {
      GIT_AUTHOR_NAME: who.name,
      GIT_AUTHOR_EMAIL: who.email,
      GIT_AUTHOR_DATE: c.date,
      GIT_COMMITTER_NAME: who.name,
      GIT_COMMITTER_EMAIL: who.email,
      GIT_COMMITTER_DATE: c.date,
    };
    await git(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', c.message], { cwd: repoPath, env });
    const sha = (await git(['rev-parse', 'HEAD'], { cwd: repoPath })).trim();
    commits.push({ sha, message: c.message });
  }
  return { id, repoPath, commits };
}

export async function buildAllDemoRepos(opts: { force?: boolean } = {}): Promise<BuiltRepo[]> {
  const out: BuiltRepo[] = [];
  for (const s of listScenarios()) out.push(await buildDemoRepo(s.id, opts));
  return out;
}
