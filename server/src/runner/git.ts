import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/**
 * Host-side git with repository-controlled behaviour disabled: no hooks, no
 * filters/LFS smudge, no credential prompts, no submodule recursion.
 */
const SAFE_FLAGS = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'protocol.file.allow=always',
  '-c', 'filter.lfs.smudge=',
  '-c', 'filter.lfs.process=',
  '-c', 'filter.lfs.required=false',
  '-c', 'advice.detachedHead=false',
];

export interface GitOptions {
  cwd: string;
  env?: Record<string, string>;
  input?: string;
  timeoutMs?: number;
}

export async function git(args: string[], opts: GitOptions): Promise<string> {
  const child = execFileP('git', [...SAFE_FLAGS, ...args], {
    cwd: opts.cwd,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: process.env.HOME ?? '/tmp',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      ...opts.env,
    },
    maxBuffer: 32 * 1024 * 1024,
    timeout: opts.timeoutMs ?? 120_000,
  });
  if (opts.input !== undefined) {
    child.child.stdin?.end(opts.input);
  }
  const { stdout } = await child;
  return stdout;
}

export async function gitOk(args: string[], opts: GitOptions): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    return { ok: true, stdout: await git(args, opts), stderr: '' };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    return { ok: false, stdout: e.stdout ?? '', stderr: e.stderr ?? e.message };
  }
}
