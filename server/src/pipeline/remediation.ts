import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommitDiff } from '../analysis/diff.js';
import type { LogFacts } from '../analysis/logs.js';
import { newId, nowIso } from '../db/store.js';
import type { Origin, Patch, RemediationType } from '../domain/types.js';
import { escapeRegex } from '../runner/frameworks.js';
import { checkout, checkPatchPolicy, workingTreeDiff, type RepoSource } from '../runner/workspace.js';
import { git } from '../runner/git.js';

export interface CandidateEdit {
  title: string;
  strategy: RemediationType;
  origin: Origin;
  rationale: string;
  edits: Array<{ path: string; content: string }>;
}

const TEST_FILE = /(^|\/)(test|tests|__tests__|src\/test)\/|\.(test|spec)\.[cm]?[jt]sx?$|Test\.java$/;

export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path);
}

/** Quarantine: mark the flaky test as skipped, with a comment linking the evidence. */
export function quarantineCandidate(args: {
  testFile: string;
  testFullName: string;
  content: string;
  investigationId: string;
  failureSummary: string;
}): CandidateEdit | null {
  const lines = args.content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(test|it)\(\s*(['"`])(.+?)\3/.exec(lines[i]);
    if (!m) continue;
    const title = m[4];
    if (!args.testFullName.endsWith(title)) continue;
    const indent = m[1];
    const next = [...lines];
    next[i] = lines[i].replace(new RegExp(`^(\\s*)${m[2]}\\(`), `$1${m[2]}.skip(`);
    next.splice(i, 0, `${indent}// Quarantined by Alibi (investigation ${args.investigationId}): ${args.failureSummary}.`, `${indent}// Re-enable once the nondeterminism is removed.`);
    return {
      title: `Quarantine "${title}"`,
      strategy: 'quarantine',
      origin: 'deterministic',
      rationale: `Skips only the intermittently failing test so the suite stops blocking unrelated changes, and records why. ${args.failureSummary}.`,
      edits: [{ path: args.testFile, content: next.join('\n') }],
    };
  }
  return null;
}

/** Dependency pin: restore the previous version on the exact manifest line that changed. */
export function pinCandidate(diff: CommitDiff, readFile: (p: string) => string | null): CandidateEdit | null {
  const change = diff.dependencyChanges.find((d) => d.from && d.to && d.removedLine && d.addedLine);
  if (!change) return null;
  const content = readFile(change.file);
  if (!content || !content.includes(change.addedLine!)) return null;
  return {
    title: `Pin ${change.name} back to ${change.from}`,
    strategy: 'dependency_pin',
    origin: 'deterministic',
    rationale: `Restores ${change.name} ${change.from} (the version used by the passing parent commit) until the code is migrated to ${change.to}.`,
    edits: [{ path: change.file, content: content.replace(change.addedLine!, change.removedLine!) }],
  };
}

/** Revert: restore the non-test source files this commit changed to their parent versions. */
export async function revertCandidate(repoDir: string, parentSha: string, diff: CommitDiff): Promise<CandidateEdit | null> {
  const files = diff.files.map((f) => f.path).filter((p) => !isTestFile(p) && !/\.(md|txt)$/i.test(p) && !/^\.github\//.test(p));
  if (!files.length || files.length > 5) return null;
  const edits: CandidateEdit['edits'] = [];
  for (const path of files) {
    try {
      edits.push({ path, content: await git(['show', `${parentSha}:${path}`], { cwd: repoDir }) });
    } catch {
      return null; // file added in this commit; a revert would need deletion
    }
  }
  return {
    title: `Revert ${files.join(', ')} to the parent commit`,
    strategy: 'code_patch',
    origin: 'deterministic',
    rationale: 'Restores the last known-good version of the source files changed by the failing commit. Broad but safe; prefer a targeted fix when one validates.',
    edits,
  };
}

/** Files to show the patch model: implicated sources first, then manifests and the failing test. */
export function patchContextFiles(facts: LogFacts, diff: CommitDiff | null): string[] {
  const out: string[] = [];
  for (const c of facts.compileErrors) out.push(c.file);
  for (const f of diff?.files ?? []) if (!isTestFile(f.path) && !/\.(md|txt)$/i.test(f.path)) out.push(f.path);
  for (const f of facts.failingFiles) out.push(f);
  return [...new Set(out)].slice(0, 4);
}

/**
 * Writes candidate edits into a scratch checkout of `sha` and returns the
 * resulting unified diff as a Patch (status "proposed"), or null if the edit
 * is a no-op or violates the patch policy.
 */
export async function materialize(
  source: RepoSource,
  sha: string,
  scratchDir: string,
  investigationId: string,
  cand: CandidateEdit,
  allowedPaths?: string[],
): Promise<{ patch: Patch | null; problem?: string }> {
  await checkout(source, sha, scratchDir);
  for (const e of cand.edits) {
    if (allowedPaths && !allowedPaths.includes(e.path)) return { patch: null, problem: `Edit to ${e.path} is outside the files provided to the model.` };
    const target = join(scratchDir, e.path);
    if (!e.path || e.path.startsWith('/') || e.path.split('/').includes('..') || !existsSync(target)) {
      return { patch: null, problem: `Invalid or unknown path ${e.path}` };
    }
    const original = readFileSync(target, 'utf8');
    // Preserve the file's trailing newline convention.
    const content = original.endsWith('\n') && !e.content.endsWith('\n') ? `${e.content}\n` : e.content;
    writeFileSync(target, content);
  }
  const diff = await workingTreeDiff(scratchDir);
  if (!diff.trim()) return { patch: null, problem: 'Candidate produced no changes.' };
  const policy = checkPatchPolicy(diff);
  if (!policy.ok) return { patch: null, problem: policy.reasons.join('; ') };
  return {
    patch: {
      id: newId('patch'),
      investigationId,
      origin: cand.origin,
      strategy: cand.strategy,
      title: cand.title,
      rationale: cand.rationale,
      diff,
      files: policy.files,
      status: 'proposed',
      validation: null,
      prUrl: null,
      prBranch: null,
      createdAt: nowIso(),
    },
  };
}

export function testTitleRegex(name: string): RegExp {
  return new RegExp(escapeRegex(name));
}
