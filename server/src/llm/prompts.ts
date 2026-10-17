import type { CommitDiff } from '../analysis/diff.js';
import type { LogExcerpt, LogFacts } from '../analysis/logs.js';
import type { ExternalSource, Experiment, Hypothesis, Investigation } from '../domain/types.js';
import { PRODUCT_NAME } from '../brand.js';

export const TRIAGE_SYSTEM = `You are the log-triage stage of ${PRODUCT_NAME}, an evidence-driven CI investigation system.
You read CI log excerpts, deterministic log facts, and the commit diff, then propose competing hypotheses that experiments can test.

Rules:
- Every supporting or contradicting evidence item must quote text that appears verbatim in the provided log excerpts or diff, with the log line number when it comes from the log. Quotes are machine-checked; unverifiable quotes are flagged.
- Propose 2 to 4 genuinely different hypotheses (e.g. code regression vs flaky test vs dependency change vs infrastructure). Include the strongest alternative explanation even if you think it is less likely.
- "experiments" may only use: reproduce (re-run failing test at the failing commit), repeat (run it many times to measure intermittency), compare_parent (run at the parent commit), external_search (search the web for release notes, incidents, or known issues).
- heuristic_confidence is your rough prior in [0,1]; it is NOT a calibrated probability and will be labeled as a heuristic.
- search_queries: up to 3 precise web queries grounded in exact package names, versions, and error messages from the evidence. Leave empty if no external cause is plausible.
- Output a single JSON object matching the schema. No prose outside JSON.`;

export function triagePrompt(args: {
  inv: Investigation;
  facts: LogFacts;
  excerpts: LogExcerpt[];
  diff: CommitDiff | null;
}): string {
  const { inv, facts, excerpts, diff } = args;
  const parts = [
    `## Build metadata`,
    `repository: ${inv.repository}`,
    `commit: ${inv.commitSha} (parent ${inv.parentSha ?? 'unknown'})`,
    `commit message: ${inv.commitMessage ?? 'unknown'}`,
    `branch: ${inv.branch ?? 'unknown'}; workflow: ${inv.workflow ?? 'unknown'}; job: ${inv.job ?? 'unknown'}`,
    `framework: ${facts.framework}`,
    ``,
    `## Deterministic log facts (parsed by ${PRODUCT_NAME}, not by a model)`,
    JSON.stringify(
      {
        signature: facts.signature,
        failingTests: facts.failingTests,
        compileErrors: facts.compileErrors,
        assertion: facts.assertion,
        jestSeed: facts.jestSeed,
        testSummary: facts.testSummary,
        exitCode: facts.exitCode,
        resolvedArtifacts: facts.downloads.slice(0, 25),
      },
      null,
      1,
    ),
    ``,
    `## Commit diff`,
    diff
      ? [
          `files: ${diff.files.map((f) => `${f.path} (+${f.additions}/-${f.deletions})`).join(', ')}`,
          `docs-only change: ${diff.onlyDocs}`,
          `dependency changes: ${JSON.stringify(diff.dependencyChanges)}`,
          '```diff',
          diff.diff,
          '```',
        ].join('\n')
      : 'unavailable',
    ``,
    `## CI log excerpts (line numbers are 1-based positions in the full log)`,
    ...excerpts.map((e) => `--- lines ${e.startLine}-${e.endLine} (${e.reason}) ---\n${e.text}`),
  ];
  return parts.join('\n');
}

export const VERDICT_SYSTEM = `You are the evidence-weighing stage of ${PRODUCT_NAME}, an evidence-driven CI investigation system.
You receive competing hypotheses and an evidence ledger of executed experiments with their actual results. Decide which hypotheses the evidence supports or refutes.

Rules:
- Base conclusions only on the ledger. Distinguish what experiments showed from what you infer.
- "confirmed" requires a discriminating experiment (e.g. failing commit fails deterministically AND parent passes, or a candidate fix passes the failing test). Otherwise use "probable" or "inconclusive".
- A retry that passes does not by itself prove flakiness or causation; intermittency must be measured across repeated runs.
- Treat web search results as leads, not proof.
- Prefer conservative remediation when uncertain. remediation_type: retry (transient infra), quarantine (strongly supported flaky test), dependency_pin (dependency regression), code_patch (understood code regression), none.
- limitations: list what the experiments could not establish (sample size, environment differences, untested hypotheses).
- Output a single JSON object matching the schema.`;

export function verdictPrompt(args: {
  inv: Investigation;
  hypotheses: Hypothesis[];
  experiments: Experiment[];
  sources: ExternalSource[];
  diffSummary: string;
}): string {
  const exp = args.experiments.map((e) => ({
    id: e.id,
    kind: e.kind,
    hypothesis: e.hypothesisKey,
    commit: e.commitSha?.slice(0, 12),
    selection: e.testSelection,
    status: e.status,
    passes: e.result?.passes,
    failures: e.result?.failures,
    attempts: e.result?.attempts.length,
    failureRate: e.result?.failureRate,
    observation: e.observation,
  }));
  return [
    `## Failure`,
    `repository: ${args.inv.repository} @ ${args.inv.commitSha.slice(0, 12)}; commit message: ${args.inv.commitMessage ?? ''}`,
    `signature: ${args.inv.failureSignature}`,
    `diff: ${args.diffSummary}`,
    ``,
    `## Hypotheses`,
    JSON.stringify(
      args.hypotheses.map((h) => ({ id: h.key, cause: h.cause, category: h.category, prior: h.prior, supporting: h.supporting.map((s) => s.text), contradicting: h.contradicting.map((s) => s.text) })),
      null,
      1,
    ),
    ``,
    `## Executed experiments (actual results)`,
    JSON.stringify(exp, null, 1),
    ``,
    `## External sources (web search results; leads, not proof)`,
    args.sources.length
      ? JSON.stringify(args.sources.slice(0, 6).map((s) => ({ title: s.title, url: s.url, official: s.official, excerpt: s.excerpt.slice(0, 400) })), null, 1)
      : 'none',
  ].join('\n');
}

export const PATCH_SYSTEM = `You are the remediation stage of ${PRODUCT_NAME}, an evidence-driven CI investigation system.
Write the smallest change that fixes the confirmed root cause. You will be given the failing test output, the commit diff that introduced the failure, and the current contents of relevant files.

Rules:
- Return the COMPLETE new content of each file you change (at most 3 files). Test files are read-only: they are shown for context, and any edit to them is rejected. Fix the code under test.
- Do not modify CI configuration, build scripts, or files under .github/.
- Keep unrelated code unchanged, including formatting.
- Output a single JSON object matching the schema.`;

export function patchPrompt(args: { signature: string; failureOutput: string; diff: string; files: Array<{ path: string; content: string; readOnly?: boolean }>; rootCause: string }): string {
  return [
    `## Root cause (from evidence)`,
    args.rootCause,
    `## Failure signature`,
    args.signature,
    `## Failing test output (sandbox run)`,
    '```',
    args.failureOutput.slice(-6000),
    '```',
    `## Diff of the commit that introduced the failure`,
    '```diff',
    args.diff.slice(0, 12_000),
    '```',
    `## Current file contents at the failing commit`,
    ...args.files.map((f) => `### ${f.path}${f.readOnly ? ' (read-only test file: context only)' : ''}\n\`\`\`\n${f.content}\n\`\`\``),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Bounded agent loop

export const LOOP_SYSTEM = `You are the experiment-selection stage of ${PRODUCT_NAME}, an evidence-driven CI investigation system.
You see competing hypotheses and the ACTUAL results of experiments already executed in an isolated sandbox. Choose the single next experiment that best discriminates between the remaining hypotheses, or conclude.

Rules:
- Use only the tools, argument names, and argument values listed in "Allowed actions". You cannot run commands, choose file paths, set environment variables, or change code. Any other argument, including unknown ones, makes the whole action be rejected by policy.
- State a concrete, falsifiable prediction for the experiment (what result each leading hypothesis predicts).
- Revise hypotheses based on the observed results: strengthened, weakened, refuted, or unchanged, each with a reason that cites an observation.
- Do not repeat an experiment that has already run with the same arguments.
- Conclude when the evidence already discriminates between the hypotheses, or when no allowed experiment could change the assessment.
- Output a single JSON object matching the schema.`;

export interface LoopObservation {
  step: number | 'baseline';
  tool: string;
  commit: string;
  selection: string;
  passes: number;
  failures: number;
  exitCodes: Array<number | null>;
  summary: string;
  outputTail: string;
}

export function loopPrompt(args: {
  hypotheses: Array<{ key: string; cause: string; category: string }>;
  selections: Array<{ id: string; label: string }>;
  hasParent: boolean;
  searchEnabled: boolean;
  observations: LoopObservation[];
  remaining: { iterations: number; runs: number; searches: number };
}): string {
  const actions = [
    `- reproduce { "commit": "failing"${args.hasParent ? ' | "parent"' : ''}, "test": <selection id> } — run once`,
    `- repeat { "commit": "failing"${args.hasParent ? ' | "parent"' : ''}, "test": <selection id>, "runs": 2-10 } — run several times with fresh seeds`,
    `- run_test { "commit": "failing"${args.hasParent ? ' | "parent"' : ''}, "test": <selection id> } — run a different allowed selection`,
    ...(args.searchEnabled ? ['- search { "query": "<8-200 chars: exact package, version, error symbol>" } — web search; results are leads, not proof'] : []),
  ];
  return [
    '## Hypotheses',
    ...args.hypotheses.map((h) => `- ${h.key} [${h.category}] ${h.cause}`),
    '',
    '## Allowed test selections',
    ...args.selections.map((s) => `- ${s.id}: ${s.label}`),
    '',
    '## Allowed actions',
    ...actions,
    '',
    `## Remaining budget: ${args.remaining.iterations} decision(s), ${args.remaining.runs} test run(s), ${args.remaining.searches} search(es)`,
    '',
    '## Experiments already executed (actual sandbox results)',
    ...args.observations.map(
      (o) =>
        `### ${o.step === 'baseline' ? 'baseline' : `step ${o.step}`}: ${o.tool} on ${o.commit} commit, ${o.selection}\n` +
        `result: ${o.failures} failed / ${o.passes} passed; exit codes ${JSON.stringify(o.exitCodes)}\n${o.summary}` +
        (o.outputTail ? `\n\`\`\`\n${o.outputTail}\n\`\`\`` : ''),
    ),
  ].join('\n');
}

export function patchRetryPrompt(base: string, previous: { diff: string; failureOutput: string; summary: string }): string {
  return [
    base,
    '',
    '## Your previous candidate FAILED validation in a fresh sandbox',
    previous.summary,
    '```diff',
    previous.diff.slice(0, 6000),
    '```',
    '## Actual failing output from that validation run',
    '```',
    previous.failureOutput.slice(-4000),
    '```',
    'Write a corrected fix that makes the failing tests pass without changing test files or expected behaviour asserted by tests.',
  ].join('\n');
}
