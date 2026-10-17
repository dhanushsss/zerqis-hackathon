import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommitDiff } from '../analysis/diff.js';
import type { LogFacts } from '../analysis/logs.js';
import { newId, nowIso } from '../db/store.js';
import type { Origin, Patch, RemediationType } from '../domain/types.js';
import { escapeRegex } from '../runner/frameworks.js';
import { isRequirementsFile } from '../runner/python.js';
import { checkout, checkPatchPolicy, workingTreeDiff, type RepoSource } from '../runner/workspace.js';
import { git } from '../runner/git.js';
import { PRODUCT_NAME } from '../brand.js';

export interface CandidateEdit {
  title: string;
  strategy: RemediationType;
  origin: Origin;
  rationale: string;
  edits: Array<{ path: string; content: string }>;
}

const TEST_FILE = /(^|\/)(test|tests|__tests__|src\/test|testdata)\/|\.(test|spec)\.[cm]?[jt]sx?$|Test\.java$|(^|\/)test_[^/]*\.py$|_test\.py$|(^|\/)(conftest\.py|pytest\.ini)$|_test\.go$/;

export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path);
}

/** Documentation-like files that are not worth patching; dependency manifests are not documentation. */
function isDocLike(path: string): boolean {
  return /\.(md|txt)$/i.test(path) && !isRequirementsFile(path);
}

/** Quarantine: mark the flaky test as skipped, with a comment linking the evidence. */
export function quarantineCandidate(args: {
  testFile: string;
  testFullName: string;
  content: string;
  investigationId: string;
  failureSummary: string;
}): CandidateEdit | null {
  if (args.testFile.endsWith('.py')) return quarantinePytest(args);
  if (args.testFile.endsWith('_test.go')) return quarantineGo(args);
  const lines = args.content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(test|it)\(\s*(['"`])(.+?)\3/.exec(lines[i]);
    if (!m) continue;
    const title = m[4];
    if (!args.testFullName.endsWith(title)) continue;
    const indent = m[1];
    const next = [...lines];
    next[i] = lines[i].replace(new RegExp(`^(\\s*)${m[2]}\\(`), `$1${m[2]}.skip(`);
    next.splice(i, 0, `${indent}// Quarantined by ${PRODUCT_NAME} (investigation ${args.investigationId}): ${args.failureSummary}.`, `${indent}// Re-enable once the nondeterminism is removed.`);
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

/** pytest quarantine: a skip marker on the failing test function (all of its parameter cases). */
function quarantinePytest(args: { testFile: string; testFullName: string; content: string; investigationId: string; failureSummary: string }): CandidateEdit | null {
  const fn = args.testFullName.split('::').pop()!.replace(/\[.*$/, '');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(fn)) return null;
  const lines = args.content.split('\n');
  const at = lines.findIndex((l) => new RegExp(`^\\s*(async\\s+)?def\\s+${fn}\\s*\\(`).test(l));
  if (at < 0) return null;
  const indent = /^(\s*)/.exec(lines[at])![1];
  // Decorators stack directly above "def"; the new marker goes above the first of them.
  let insertAt = at;
  while (insertAt > 0 && new RegExp(`^${indent}@`).test(lines[insertAt - 1])) insertAt--;
  const reason = JSON.stringify(`Quarantined by ${PRODUCT_NAME} (investigation ${args.investigationId}): ${args.failureSummary}`);
  const next = [...lines];
  next.splice(insertAt, 0, `${indent}# Re-enable once the nondeterminism is removed.`, `${indent}@pytest.mark.skip(reason=${reason})`);
  if (!/^import pytest\s*$/m.test(args.content)) {
    // "from __future__" imports must stay first.
    const future = next.reduce((last, l, i) => (/^from __future__ import /.test(l) ? i : last), -1);
    next.splice(future + 1, 0, 'import pytest');
  }
  return {
    title: `Quarantine "${fn}"`,
    strategy: 'quarantine',
    origin: 'deterministic',
    rationale: `Skips only the intermittently failing test so the suite stops blocking unrelated changes, and records why. ${args.failureSummary}.`,
    edits: [{ path: args.testFile, content: next.join('\n') }],
  };
}

/** Go quarantine: t.Skip as the first statement of the failing top-level test function. */
function quarantineGo(args: { testFile: string; testFullName: string; content: string; investigationId: string; failureSummary: string }): CandidateEdit | null {
  const fn = args.testFullName.split('/')[0];
  if (!/^Test[A-Za-z0-9_]*$/.test(fn)) return null;
  const lines = args.content.split('\n');
  const at = lines.findIndex((l) => new RegExp(`^func\\s+${fn}\\s*\\(\\s*(\\w+)\\s+\\*testing\\.T\\s*\\)\\s*\\{\\s*$`).test(l));
  if (at < 0) return null;
  const tVar = new RegExp(`\\(\\s*(\\w+)\\s+\\*testing`).exec(lines[at])![1];
  const reason = JSON.stringify(`Quarantined by ${PRODUCT_NAME} (investigation ${args.investigationId}): ${args.failureSummary}`);
  const next = [...lines];
  next.splice(at + 1, 0, `\t// Re-enable once the nondeterminism is removed.`, `\t${tVar}.Skip(${reason})`);
  return {
    title: `Quarantine "${fn}"`,
    strategy: 'quarantine',
    origin: 'deterministic',
    rationale: `Skips only the intermittently failing test so the suite stops blocking unrelated changes, and records why. ${args.failureSummary}.`,
    edits: [{ path: args.testFile, content: next.join('\n') }],
  };
}

/** Dependency pin: restore the previous version on the exact manifest line that changed. */
export function pinCandidate(diff: CommitDiff, readFile: (p: string) => string | null): CandidateEdit | null {
  const change = diff.dependencyChanges.find((d) => d.from && d.to && d.removedLine && d.addedLine);
  if (!change) return null;
  const content = readFile(change.file);
  if (!content || !content.includes(change.addedLine!)) return null;
  if (change.ecosystem === 'go') {
    // Go verifies every module against go.sum, so the previous version's checksums must come back too.
    const sums = change.previousSums ?? [];
    const goSum = readFile('go.sum');
    if (!sums.some((l) => !/\/go\.mod /.test(l)) || goSum === null) return null;
    const merged = [...new Set([...goSum.split('\n').filter(Boolean), ...sums])].sort();
    return {
      title: `Pin ${change.name} back to ${change.from}`,
      strategy: 'dependency_pin',
      origin: 'deterministic',
      rationale: `Restores ${change.name} ${change.from} (the version used by the passing parent commit) and its go.sum checksums until the code is migrated to ${change.to}.`,
      edits: [
        { path: change.file, content: content.replace(change.addedLine!, change.removedLine!) },
        { path: 'go.sum', content: `${merged.join('\n')}\n` },
      ],
    };
  }
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
  const files = diff.files.map((f) => f.path).filter((p) => !isTestFile(p) && !isDocLike(p) && !/^\.github\//.test(p));
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
  for (const f of diff?.files ?? []) if (!isTestFile(f.path) && !isDocLike(f.path)) out.push(f.path);
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
    // Model-written edits (allowedPaths set) may never touch tests, even if a caller allowed them.
    if (allowedPaths && isTestFile(e.path)) return { patch: null, problem: `Edit to ${e.path} is outside the files provided to the model: test files are read-only for model-written fixes.` };
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
