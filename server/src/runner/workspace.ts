import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import type { Framework } from '../domain/types.js';
import { runContainer, type ContainerResult } from './docker.js';
import { envFor, hasLockfile, imageFor, installCommands } from './frameworks.js';
import { git, gitOk } from './git.js';

export interface Workspace {
  dir: string;
  sha: string;
  framework: Framework;
  cacheDir: string;
  /** Dependency-preparation steps (network-enabled). A failing Maven warm-up is expected when the commit does not compile. */
  install: ContainerResult[];
}

export interface RepoSource {
  /** Local path or https:// URL of the repository to clone. */
  location: string;
  /** Stable identifier used to key the dependency cache (one cache per repository). */
  cacheKey: string;
}

const SHA = /^[0-9a-f]{7,40}$/;

function cacheDirFor(key: string): string {
  const dir = join(config.dataDir, 'cache', createHash('sha256').update(key).digest('hex').slice(0, 16));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function assertSafeLocation(location: string) {
  if (/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?$/.test(location)) return;
  if (location.startsWith('/') && !location.includes('..')) return;
  throw new Error(`Refusing to clone from ${location}`);
}

/** Clones `source` at `sha` into a fresh directory with hooks disabled. */
export async function checkout(source: RepoSource, sha: string, dir: string): Promise<void> {
  if (!SHA.test(sha)) throw new Error(`Invalid commit SHA: ${sha}`);
  assertSafeLocation(source.location);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  await git(['clone', '--quiet', '--no-checkout', '--no-recurse-submodules', source.location, dir], {
    cwd: config.dataDir,
    timeoutMs: 300_000,
  });
  try {
    await git(['checkout', '--quiet', '--detach', sha], { cwd: dir });
  } catch {
    // Commits only reachable from pull-request refs (e.g. fork PRs) are not in a
    // default clone; GitHub serves them when fetched by SHA.
    await git(['fetch', '--quiet', '--depth=1', 'origin', sha], { cwd: dir, timeoutMs: 300_000 });
    await git(['checkout', '--quiet', '--detach', sha], { cwd: dir });
  }
  mkdirSync(join(dir, '.alibi'), { recursive: true });
  writeFileSync(join(dir, '.alibi', '.gitignore'), '*\n');
}

/**
 * Prepares an isolated workspace for `sha`: clean checkout, then dependency
 * installation in a network-enabled container (no secrets, non-root). Test
 * runs that follow are executed with networking disabled.
 */
export async function prepareWorkspace(
  source: RepoSource,
  sha: string,
  dir: string,
  framework: Framework,
): Promise<Workspace> {
  await checkout(source, sha, dir);
  const cacheDir = cacheDirFor(source.cacheKey);
  const install: ContainerResult[] = [];
  if (framework === 'jest' || framework === 'maven') {
    for (const command of installCommands(framework, hasLockfile(dir), dir)) {
      const res = await runContainer({
        image: imageFor(framework),
        command,
        workspace: dir,
        cacheDir,
        network: true,
        env: envFor(framework),
        timeoutSec: config.runner.installTimeoutSec,
      });
      install.push(res);
      if (framework === 'jest' && res.exitCode !== 0) break;
    }
    if (framework === 'maven') {
      // Surefire also loads junit-platform-launcher at test time, aligned with the
      // project's resolved JUnit Platform version.
      for (const version of resolvedVersions(cacheDir, 'org/junit/platform/junit-platform-engine')) {
        if (existsSync(join(cacheDir, 'm2/org/junit/platform/junit-platform-launcher', version))) continue;
        install.push(
          await runContainer({
            image: imageFor(framework),
            command: ['mvn', '-B', '-q', '-Dmaven.repo.local=/cache/m2', 'dependency:get', `-Dartifact=org.junit.platform:junit-platform-launcher:${version}`],
            workspace: dir,
            cacheDir,
            network: true,
            env: envFor(framework),
            timeoutSec: config.runner.installTimeoutSec,
          }),
        );
      }
    }
  }
  return { dir, sha, framework, cacheDir, install };
}

function resolvedVersions(cacheDir: string, artifactPath: string): string[] {
  const dir = join(cacheDir, 'm2', artifactPath);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((v) => /^[0-9][\w.-]{0,30}$/.test(v) && existsSync(join(dir, v, `${artifactPath.split('/').pop()}-${v}.jar`)));
}

// ---------------------------------------------------------------------------
// Patches

export interface PatchPolicyResult {
  ok: boolean;
  files: string[];
  reasons: string[];
}

const BLOCKED_PATH = [/^\.git\//, /^\.github\//, /(^|\/)\.npmrc$/, /^\.mvn\//, /(^|\/)\.env/, /^\.alibi\//];
const MAX_PATCH_BYTES = 64 * 1024;

/** Deterministic policy for candidate patches before they touch any workspace. */
export function checkPatchPolicy(diff: string): PatchPolicyResult {
  const reasons: string[] = [];
  if (Buffer.byteLength(diff) > MAX_PATCH_BYTES) reasons.push('Patch exceeds 64 KiB');
  const files = new Set<string>();
  for (const m of diff.matchAll(/^(?:---|\+\+\+) (?:a\/|b\/)?(.+)$/gm)) {
    const p = m[1].trim();
    if (p === '/dev/null') continue;
    files.add(p);
  }
  for (const m of diff.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)) {
    files.add(m[1]);
    files.add(m[2]);
  }
  if (files.size === 0) reasons.push('Patch does not modify any files');
  for (const f of files) {
    if (f.startsWith('/') || f.split('/').includes('..')) reasons.push(`Path escapes repository: ${f}`);
    if (BLOCKED_PATH.some((r) => r.test(f))) reasons.push(`Path is not allowed: ${f}`);
  }
  if (/^(old|new) mode /m.test(diff) || /^new file mode 1[02]0755/m.test(diff)) reasons.push('Mode changes are not allowed');
  if (/^GIT binary patch/m.test(diff)) reasons.push('Binary patches are not allowed');
  if (/^(rename|copy) (from|to) /m.test(diff)) reasons.push('Renames are not allowed');
  if (/^new file mode 120000/m.test(diff)) reasons.push('Symlinks are not allowed');
  return { ok: reasons.length === 0, files: [...files], reasons };
}

/** Applies a policy-checked unified diff to a workspace. */
export async function applyPatch(dir: string, diff: string): Promise<{ ok: boolean; detail: string }> {
  const policy = checkPatchPolicy(diff);
  if (!policy.ok) return { ok: false, detail: policy.reasons.join('; ') };
  const patchFile = join(dir, '.alibi', 'candidate.patch');
  writeFileSync(patchFile, diff.endsWith('\n') ? diff : `${diff}\n`);
  const check = await gitOk(['apply', '--check', '--whitespace=nowarn', patchFile], { cwd: dir });
  if (!check.ok) return { ok: false, detail: `git apply --check failed: ${check.stderr.trim()}` };
  const res = await gitOk(['apply', '--whitespace=nowarn', patchFile], { cwd: dir });
  return res.ok ? { ok: true, detail: 'Applied cleanly' } : { ok: false, detail: res.stderr.trim() };
}

/** Diff of working-tree changes (used to turn model-rewritten files into a reviewable patch). */
export async function workingTreeDiff(dir: string): Promise<string> {
  return git(['diff', '--no-color', '--no-ext-diff'], { cwd: dir });
}

export function cleanupWorkspace(dir: string) {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}
