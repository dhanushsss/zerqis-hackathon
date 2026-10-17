import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ZodType, ZodTypeDef } from 'zod';
import { config } from '../config.js';
import { analyzeDiff, commitDiff, type CommitDiff } from '../analysis/diff.js';
import { cleanLine, extractFacts, logStats, selectExcerpts, splitLines, verifyQuote, type LogFacts } from '../analysis/logs.js';
import { redactSecrets } from '../analysis/redact.js';
import { pct } from '../analysis/stats.js';
import { newId, nowIso, type Store } from '../db/store.js';
import type {
  Classification,
  EvidenceRef,
  Experiment,
  ChangeOutcome,
  ChangeRevisionRun,
  ExperimentKind,
  Framework,
  Hypothesis,
  Investigation,
  Origin,
  Patch,
  ReasoningMode,
} from '../domain/types.js';
import { GitHubClient, type RunRef } from '../integrations/github.js';
import { isOfficialSource, tavilyConfigured, tavilySearch } from '../integrations/tavily.js';
import { ModelError, TokenFactoryClient } from '../llm/client.js';
import type { ModelRole } from '../llm/models.js';
import {
  PATCH_JSON_SCHEMA,
  PatchSchema,
  TRIAGE_JSON_SCHEMA,
  TriageSchema,
  NEXT_ACTION_JSON_SCHEMA,
  NextActionSchema,
  VERDICT_JSON_SCHEMA,
  VerdictSchema,
  type NextActionOutput,
  type TriageOutput,
  type VerdictOutput,
} from '../llm/schemas.js';
import { LOOP_SYSTEM, loopPrompt, PATCH_SYSTEM, patchPrompt, patchRetryPrompt, TRIAGE_SYSTEM, triagePrompt, VERDICT_SYSTEM, verdictPrompt, type LoopObservation } from '../llm/prompts.js';
import { checkDocker } from '../runner/docker.js';
import type { TestSelection } from '../runner/frameworks.js';
import { checkout, layoutProblem, type RepoSource } from '../runner/workspace.js';
import { detectFramework, imageFor } from '../runner/frameworks.js';
import { findGoTestFile } from '../runner/golang.js';
import { git, gitOk } from '../runner/git.js';
import { validateSelection } from '../runner/frameworks.js';
import { demoRepoPath } from '../scenarios/build.js';
import { getScenario, scenarioLogPath } from '../scenarios/registry.js';
import { assessConfidence, guardHypothesisStatus, reconcileVerdict, remediationSummary } from './confidence.js';
import { experimentEffect } from './effects.js';
import { attemptSeed, describeSelection, runTestExperiment, summarizeAttempts, WorkspacePool } from './experiments.js';
import { heuristicTriage, heuristicVerdict } from './heuristic.js';
import { isTestFile, materialize, patchContextFiles, pinCandidate, quarantineCandidate, revertCandidate, type CandidateEdit } from './remediation.js';
import { actionKey, diagnosisOutcome, fixOutcome, runAgentLoop, STOP_REASON_TEXT, type ApprovedAction, type LoopResult, type SelectionOption } from './agentLoop.js';
import { loadReplay, saveReplay, type ReplayRecording } from './replay.js';
import { changeFixOutcome, decideFailingChange, decidePassingChange, notTestedFor, parseRepoUrl, resolveRevision, syncRemoteRepo, testScopeConcerns } from './change.js';
import { PRODUCT_NAME } from '../brand.js';

/** Frameworks with sandbox experiment support. */
const SANDBOX_FRAMEWORKS: Framework[] = ['jest', 'maven', 'pytest', 'go'];
const SUPPORTED_TEXT = 'Jest (JavaScript and TypeScript), Maven, pytest, Go';

export interface PipelineDeps {
  store: Store;
  llm: TokenFactoryClient;
  github: GitHubClient;
}

/** Everything the pipeline needs to know about where the code and log come from. */
interface Intake {
  source: RepoSource;
  log: string;
  diff: CommitDiff | null;
  repoDir: string | null;
  githubRef?: RunRef;
  /** Values already redacted before the log reached the pipeline (GitHub downloads). */
  preRedactions?: number;
}

class Budget {
  used = 0;
  constructor(readonly max: number) {}
  take(): boolean {
    if (this.used >= this.max) return false;
    this.used++;
    return true;
  }
}

export class InvestigationRun {
  private readonly store: Store;
  private budget = new Budget(config.nebius.maxCallsPerInvestigation);
  private recording: ReplayRecording | null = null;
  private replay: ReplayRecording | null = null;
  private pool!: WorkspacePool;
  private workRoot: string;
  private facts!: LogFacts;
  private intake!: Intake;
  private limitations: string[] = [];

  constructor(
    private readonly deps: PipelineDeps,
    readonly id: string,
  ) {
    this.store = deps.store;
    this.workRoot = join(config.dataDir, 'workspaces', id);
  }

  private get inv(): Investigation {
    return this.store.getInvestigation(this.id)!;
  }

  private update(patch: Partial<Investigation>) {
    return this.store.updateInvestigation(this.id, patch);
  }

  /** When true (re-validation of an existing patch), stage updates don't touch the investigation status. */
  private quiet = false;

  private stage(stage: string) {
    if (this.quiet) return;
    this.update({ stage, status: 'running' });
  }

  private evidence(e: Parameters<Store['addEvidence']>[0] extends infer T ? Omit<T, 'investigationId'> : never) {
    return this.store.addEvidence({ ...e, investigationId: this.id });
  }

  // ------------------------------------------------------------------ run
  async run(): Promise<void> {
    try {
      this.stage('Collecting failure evidence');
      this.intake = await this.collect();
      if (this.changeEarly) {
        // Change verification that needs no diagnosis: blocked, or no failing test at the changed revision.
        this.finishChange(this.changeEarly.outcome, this.changeEarly.detail);
        return;
      }
      this.prepareMode();

      this.stage('Forming hypotheses');
      const hypotheses = await this.formHypotheses();

      this.stage('Planning experiments');
      const planned = await this.plan(hypotheses);

      this.stage('Running experiments');
      await this.execute(planned, hypotheses);
      if (config.agentLoop.enabled) {
        this.stage('Agent loop: choosing experiments');
        await this.iterate(hypotheses);
      }

      this.stage('Weighing evidence');
      const verdict = await this.weigh();

      this.stage('Testing remediation');
      await this.remediate(verdict);

      this.stage('Finalizing verdict');
      this.finalize(verdict);
      if (this.inv.source === 'change') this.finalizeChange();
      if (this.recording && Object.keys(this.recording.steps).length) saveReplay(this.recording);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.update({ status: 'failed', stage: 'Failed', error: message });
      this.evidence({
        kind: 'observed_fact',
        title: 'Investigation stopped',
        detail: message,
        hypothesisKey: null,
        experimentId: null,
        sourceId: null,
        effect: null,
        provenance: { type: 'policy', ref: 'pipeline' },
      });
    } finally {
      if (existsSync(this.workRoot)) rmSync(this.workRoot, { recursive: true, force: true });
    }
  }

  // ------------------------------------------------------------ 1. collect
  private async collect(): Promise<Intake> {
    let inv = this.inv;
    let intake: Intake;
    if (inv.source === 'change') {
      intake = await this.collectChange();
      inv = this.inv;
    } else if (inv.source === 'demo') {
      const scenario = getScenario(inv.scenarioId!);
      if (!scenario) throw new Error(`Unknown scenario ${inv.scenarioId}`);
      const repoDir = demoRepoPath(scenario.id);
      const raw = readFileSync(scenarioLogPath(scenario.id), 'utf8');
      const diff = inv.parentSha ? await commitDiff(repoDir, inv.parentSha, inv.commitSha) : null;
      intake = { source: { location: repoDir, cacheKey: `demo:${scenario.id}` }, log: raw, diff, repoDir };
      this.evidence({
        kind: 'observed_fact',
        title: 'CI log loaded from demo fixture',
        detail: `The CI log for this scenario was captured from a real sandboxed run of ${scenario.repository} at ${inv.commitSha.slice(0, 12)} and stored as a fixture (fixtures/scenarios/${scenario.id}/ci-log.txt).`,
        hypothesisKey: null,
        experimentId: null,
        sourceId: null,
        effect: null,
        provenance: { type: 'fixture', ref: `fixtures/scenarios/${scenario.id}/ci-log.txt` },
      });
    } else {
      intake = await this.collectGitHub();
    }

    const red = redactSecrets(intake.log);
    // Values removed at download time count too; the second pass only sees what is left.
    const redacted = red.count + (intake.preRedactions ?? 0);
    intake.log = red.text;
    this.store.saveLog(this.id, red.text);
    this.facts = extractFacts(red.text, inv.framework);
    if (inv.source === 'change' && !red.text) this.facts.signature = 'No failing test at the changed revision';
    const excerpts = selectExcerpts(red.text, Math.min(config.nebius.maxInputChars, 60_000));
    this.update({
      failureSignature: this.facts.signature,
      framework: this.facts.framework,
      logStats: logStats(red.text, excerpts, redacted),
    });
    if (redacted) {
      this.evidence({
        kind: 'observed_fact',
        title: `Redacted ${redacted} secret-like value(s) from the log`,
        detail: 'Redaction runs before the log is stored, displayed, or sent to any model.',
        hypothesisKey: null, experimentId: null, sourceId: null, effect: null,
        provenance: { type: 'policy', ref: 'redaction' },
      });
    }

    // Observed facts straight from the log.
    const lines = splitLines(red.text);
    const lineOf = (re: RegExp) => {
      const i = lines.findIndex((l) => re.test(cleanLine(l)));
      return i >= 0 ? i + 1 : undefined;
    };
    for (const c of this.facts.compileErrors.slice(0, 2)) {
      const at = lineOf(new RegExp(c.message.slice(0, 30).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      this.evidence({
        kind: 'observed_fact',
        title: `Compilation error in ${c.file.split('/').pop()}:${c.line}`,
        detail: [c.message, c.symbol && `symbol: ${c.symbol}`, c.location && `location: ${c.location}`].filter(Boolean).join('\n'),
        hypothesisKey: null, experimentId: null, sourceId: null, effect: null,
        provenance: { type: 'log', lines: at ? [at, at + 2] : undefined },
      });
    }
    for (const t of this.facts.failingTests.slice(0, 3)) {
      const at = lineOf(new RegExp(`●.*${t.name.split(' ').slice(-3).join(' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|${t.name.replace('#', '\\.').replace(/[$]/g, '\\$')}`));
      this.evidence({
        kind: 'observed_fact',
        title: `Failing test: ${t.name}`,
        detail: [t.file && `file: ${t.file}`, this.facts.assertion && `assertion: ${this.facts.assertion}`].filter(Boolean).join('\n') || 'Reported as failed in the CI log.',
        hypothesisKey: null, experimentId: null, sourceId: null, effect: null,
        provenance: { type: 'log', lines: at ? [at, at + 12] : undefined },
      });
    }
    if (this.facts.jestSeed !== null) {
      const at = lineOf(/^Seed:/);
      this.evidence({
        kind: 'observed_fact',
        title: `CI run used Jest seed ${this.facts.jestSeed}`,
        detail: `Jest printed the seed for this run (--showSeed). ${PRODUCT_NAME} can replay the exact run with --seed.`,
        hypothesisKey: null, experimentId: null, sourceId: null, effect: null,
        provenance: { type: 'log', lines: at ? [at, at] : undefined },
      });
    }
    const d = intake.diff;
    if (d) {
      this.evidence({
        kind: 'observed_fact',
        title: `Commit changes ${d.files.length} file(s)${d.onlyDocs ? ' — documentation only' : ''}`,
        detail: d.files.map((f) => `${f.path} (+${f.additions}/−${f.deletions})`).join('\n'),
        hypothesisKey: null, experimentId: null, sourceId: null, effect: null,
        provenance: { type: inv.source === 'github' ? 'github_api' : 'git', ref: `${inv.parentSha?.slice(0, 12)}..${inv.commitSha.slice(0, 12)}` },
      });
      for (const dep of d.dependencyChanges) {
        this.evidence({
          kind: 'observed_fact',
          title: `Dependency change: ${dep.name} ${dep.from ?? '∅'} → ${dep.to ?? '∅'}`,
          detail: `${dep.file}\n- ${dep.removedLine?.trim() ?? ''}\n+ ${dep.addedLine?.trim() ?? ''}`,
          hypothesisKey: null, experimentId: null, sourceId: null, effect: null,
          provenance: { type: inv.source === 'github' ? 'github_api' : 'git', ref: dep.file },
        });
      }
    }
    return intake;
  }

  private async collectGitHub(): Promise<Intake> {
    const inv = this.inv;
    const gh = this.deps.github;
    const [owner, repo] = inv.repository.split('/');
    const ref: RunRef = { owner, repo, runId: Number(inv.runId) };
    const jobs = await gh.listJobs(ref);
    const failed = jobs.filter((j) => j.conclusion === 'failure');
    const job = failed.find((j) => String(j.id) === inv.job) ?? failed[0];
    if (!job) {
      throw new Error(
        jobs.length === 0
          ? 'GitHub reports this run as failed but it has no jobs: it failed before any job started (typically a workflow-file error or a fork PR awaiting approval). There is no job log to investigate.'
          : `None of the run's ${jobs.length} job(s) concluded "failure" (conclusions: ${[...new Set(jobs.map((j) => j.conclusion))].join(', ')}).`,
      );
    }
    let log: string;
    let preRedactions = 0;
    try {
      ({ text: log, redactions: preRedactions } = await gh.jobLog(owner, repo, job.id));
    } catch (err) {
      throw new Error(`Could not download logs for job "${job.name}": ${(err as Error).message}${(err as { hint?: string }).hint ? ` — ${(err as { hint?: string }).hint}` : ''}`);
    }
    const artifacts = await gh.listArtifacts(ref).catch(() => []);
    let diff: CommitDiff | null = null;
    if (inv.parentSha) {
      try {
        const text = await gh.compareDiff(owner, repo, inv.parentSha, inv.commitSha);
        const commit = await gh.getCommit(owner, repo, inv.commitSha);
        const numstat = (commit.files ?? []).map((f: any) => `${f.additions}\t${f.deletions}\t${f.filename}`).join('\n');
        diff = analyzeDiff(text, numstat);
      } catch (err) {
        this.limitations.push(`Commit diff unavailable: ${(err as Error).message}`);
      }
    }
    this.update({ job: job.name, artifacts });
    this.evidence({
      kind: 'observed_fact',
      title: `Downloaded log for failed job "${job.name}"`,
      detail: `GitHub Actions run ${inv.runId}, job ${job.id}. ${artifacts.length} artifact(s) listed: ${artifacts.map((a) => a.name).join(', ') || 'none'}.`,
      hypothesisKey: null, experimentId: null, sourceId: null, effect: null,
      provenance: { type: 'github_api', url: job.html_url },
    });
    return { source: { location: `https://github.com/${owner}/${repo}`, cacheKey: `gh:${owner}/${repo}` }, log, diff, repoDir: null, githubRef: ref, preRedactions };
  }

  // ------------------------------------------------------------ change verification
  private changeEarly: { outcome: ChangeOutcome; detail: string } | null = null;
  private changeExamined: ChangeRevisionRun[] = [];
  private changeBaseSuiteId = '';

  /**
   * Collect stage for a base/head revision pair. Instead of a CI log, the evidence is the full test
   * suite run at both revisions in the sandbox; the changed revision's output takes the CI log's place
   * for the ordinary stages that follow. Anything that prevents testing ends the run as "blocked".
   */
  private async collectChange(): Promise<Intake> {
    const inv = this.inv;
    const c = inv.change!;
    const empty = (source: RepoSource, repoDir: string | null, diff: CommitDiff | null = null): Intake => ({ source, log: '', diff, repoDir });
    const block = (detail: string) => {
      this.changeEarly = { outcome: 'blocked', detail };
      this.limitations.push(detail);
    };

    let repoDir: string;
    let source: RepoSource;
    if (c.origin.kind === 'sample') {
      repoDir = demoRepoPath(c.origin.scenarioId);
      source = { location: repoDir, cacheKey: `demo:${c.origin.scenarioId}` };
    } else {
      const ref = parseRepoUrl(c.origin.url);
      if (!ref) {
        block(`Unsupported repository URL ${c.origin.url}.`);
        return empty({ location: '/', cacheKey: 'invalid' }, null);
      }
      repoDir = join(config.dataDir, 'change-repos', `${ref.owner}__${ref.repo}`);
      source = { location: ref.url, cacheKey: `gh:${ref.owner}/${ref.repo}` };
      try {
        await syncRemoteRepo(ref.url, repoDir, [c.requested.base, c.requested.head]);
      } catch (err) {
        block(`Could not fetch ${ref.url}: ${(err as Error).message.slice(0, 300)}`);
        return empty(source, null);
      }
    }

    const baseSha = await resolveRevision(repoDir, c.requested.base);
    const headSha = await resolveRevision(repoDir, c.requested.head);
    const missing = [!baseSha && `base ${c.requested.base}`, !headSha && `head ${c.requested.head}`].filter(Boolean);
    if (missing.length) {
      block(`Revision${missing.length > 1 ? 's' : ''} ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not available in ${inv.repository}. Nothing was checked out or run.`);
      return empty(source, repoDir);
    }
    if (baseSha === headSha) {
      block('The base and head revisions are the same commit, so there is no change to verify.');
      return empty(source, repoDir);
    }
    const [message, author] = (await git(['log', '-1', '--format=%s%x00%an', headSha!], { cwd: repoDir })).trim().split('\0');
    this.update({ commitSha: headSha!, parentSha: baseSha!, commitMessage: message || null, commitAuthor: author || null, change: { ...c, baseSha, headSha } });
    const ancestor = (await gitOk(['merge-base', '--is-ancestor', baseSha!, headSha!], { cwd: repoDir })).ok;
    this.evidence({
      kind: 'observed_fact',
      title: `Verifying change ${baseSha!.slice(0, 12)} → ${headSha!.slice(0, 12)}`,
      detail: `Base ${baseSha} (requested "${c.requested.base}") and head ${headSha} (requested "${c.requested.head}") resolved in ${inv.repository}.${ancestor ? '' : ' The base is not an ancestor of the head; the diff compares the two trees directly.'}`,
      hypothesisKey: null, experimentId: null, sourceId: null, effect: null,
      provenance: { type: 'git', ref: `${baseSha!.slice(0, 12)}..${headSha!.slice(0, 12)}` },
    });
    if (!ancestor) this.limitations.push('The base revision is not an ancestor of the head revision.');
    const diff = await commitDiff(repoDir, baseSha!, headSha!);
    this.update({ change: { ...this.inv.change!, changedFiles: diff.files, diff: diff.diff, diffTruncated: diff.truncated } });

    // The changed revision's layout decides the framework; nothing is installed for this check.
    const layoutDir = join(this.workRoot, 'layout-check');
    let framework: Framework;
    try {
      await checkout(source, headSha!, layoutDir);
      framework = detectFramework(layoutDir);
      const problem = layoutProblem(framework, layoutDir);
      if (problem) {
        block(problem);
        return empty(source, repoDir, diff);
      }
    } finally {
      rmSync(layoutDir, { recursive: true, force: true });
    }
    this.update({ framework });
    if (!SANDBOX_FRAMEWORKS.includes(framework)) {
      block(`No supported test framework was detected at the changed revision (supported: ${SUPPORTED_TEXT}). Nothing was run.`);
      return empty(source, repoDir, diff);
    }
    const docker = await checkDocker();
    if (!docker.ok) {
      block(`Sandbox runner unavailable: ${docker.detail}`);
      return empty(source, repoDir, diff);
    }

    this.pool = new WorkspacePool(source, this.workRoot, framework);
    const head = await this.runSuite('head', headSha!);
    const base = await this.runSuite('base', baseSha!);
    this.changeBaseSuiteId = base.id;
    this.changeExamined = [head, base].map((e, i) => ({
      revision: i === 0 ? 'head' : 'base',
      sha: e.commitSha!,
      experimentId: e.id,
      status: e.status as ChangeRevisionRun['status'],
      tests: e.result?.attempts[0]?.tests ?? null,
    }));

    if (head.status === 'error' || !head.result) {
      block(`The test suite could not run at the changed revision: ${(head.observation ?? 'no result').slice(0, 400)}`);
      return empty(source, repoDir, diff);
    }
    if (head.status === 'passed') {
      const decision = decidePassingChange(
        { status: head.status, tests: head.result.attempts[0]?.tests ?? null },
        { status: base.status, tests: base.result?.attempts[0]?.tests ?? null },
        testScopeConcerns(diff),
      );
      this.changeEarly = decision;
      return empty(source, repoDir, diff);
    }
    // A failing suite: its output is the evidence the ordinary stages work from.
    const failed = head.result.attempts.find((a) => !a.passed);
    this.evidence({
      kind: 'assumption',
      title: 'Test output from the sandbox stands in for a CI log',
      detail: `No CI log is used for a change verification. The output of the full test suite at ${headSha!.slice(0, 12)} (experiment ${head.id}) is analysed in its place; it is the last ${(failed?.outputTail.length ?? 0).toLocaleString()} characters of that run.`,
      hypothesisKey: null, experimentId: head.id, sourceId: null, effect: null,
      provenance: { type: 'experiment', ref: head.id },
    });
    return { source, log: failed?.outputTail ?? '', diff, repoDir };
  }

  /** One full-suite run at a revision, recorded like any other experiment. */
  private async runSuite(revision: 'base' | 'head', sha: string): Promise<Experiment> {
    const exp = this.store.addExperiment({
      id: newId('exp'), investigationId: this.id, hypothesisKey: null,
      kind: revision === 'head' ? 'reproduce' : 'compare_parent',
      title: revision === 'head' ? 'Run the test suite at the changed revision' : 'Run the test suite at the base revision',
      reason: revision === 'head'
        ? `Runs the full test suite at the changed revision ${sha.slice(0, 12)} in a clean, offline sandbox. This defines the scope of any conclusion.`
        : `Runs the same suite at the base revision ${sha.slice(0, 12)}, so results at the two revisions can be compared.`,
      status: 'queued', backend: 'docker', command: null, environment: null, commitSha: sha,
      testSelection: describeSelection(this.inv.framework, {}), plannedAttempts: 1, startedAt: null, finishedAt: null,
      durationMs: null, result: null, observation: null, effect: null, patchId: null,
    });
    this.stage(`Running the test suite at the ${revision === 'head' ? 'changed' : 'base'} revision`);
    let done: Experiment;
    try {
      done = await runTestExperiment({ store: this.store, experiment: exp, workspace: await this.pool.get(sha), selection: {}, seeds: [undefined] });
    } catch (err) {
      done = this.store.updateExperiment(exp.id, { status: 'error', finishedAt: nowIso(), observation: `Could not prepare the workspace: ${(err as Error).message.slice(0, 400)}` });
    }
    const summary = done.result ? summarizeAttempts(done) : done.observation ?? 'No result.';
    done = this.store.updateExperiment(done.id, { observation: done.result ? summary : done.observation });
    this.evidence({
      kind: 'experiment_result',
      title: `${revision === 'head' ? 'Changed' : 'Base'} revision ${sha.slice(0, 12)}: ${done.status === 'error' ? 'could not run' : summary}`,
      detail: done.status === 'error' ? done.observation ?? '' : `Full test suite at the ${revision === 'head' ? 'changed' : 'base'} revision. ${summary}`,
      hypothesisKey: null, experimentId: done.id, sourceId: null, effect: null,
      provenance: { type: 'experiment', ref: done.id },
    });
    return done;
  }

  /** Records the change outcome. Used directly for blocked and passing changes, and after a full investigation. */
  private finishChange(outcome: ChangeOutcome, detail: string, fix: 'VALIDATED' | 'REJECTED' | 'NONE' = 'NONE') {
    const inv = this.inv;
    const headRun = this.changeExamined.find((r) => r.revision === 'head');
    const image = this.changeExamined.length ? imageFor(inv.framework) : null;
    const change = {
      ...inv.change!,
      outcome,
      outcomeDetail: detail,
      fix,
      examined: this.changeExamined,
      notTested: notTestedFor({ outcome, image, headTests: headRun?.tests ?? null, diffTruncated: this.intake?.diff?.truncated ?? false }),
    };
    const early = this.changeEarly !== null;
    this.update({
      change,
      ...(early
        ? {
            summary: detail,
            status: outcome === 'no_regression_observed' ? 'completed' : 'inconclusive',
            stage: 'Complete',
            limitations: [...new Set([...inv.limitations, ...this.limitations])],
          }
        : {}),
    });
    if (early) this.pushVerdict('Change verified', null, detail);
    this.evidence({
      kind: 'inference',
      title: `Change verification: ${outcome.replace(/_/g, ' ')} · fix ${fix}`,
      detail: `${detail}\n\nScope: ${this.changeExamined.map((r) => `${r.revision} ${r.sha.slice(0, 12)} — ${r.tests ? `${r.tests.failed}/${r.tests.total} failed` : r.status}`).join('; ') || 'no tests ran'}.\nNot examined:\n${change.notTested.map((n) => `• ${n}`).join('\n')}`,
      hypothesisKey: inv.primaryHypothesis, experimentId: headRun?.experimentId ?? null, sourceId: null, effect: null,
      provenance: { type: 'policy', ref: 'change verification rules' },
    });
  }

  private finalizeChange() {
    const inv = this.inv;
    const experiments = this.store.listExperiments(this.id);
    const decision = decideFailingChange({
      verdict: inv.verdict,
      classification: inv.classification,
      sandboxRan: experiments.some((e) => e.backend === 'docker' && e.result),
      experiments,
      baseSuiteId: this.changeBaseSuiteId,
      headSha: inv.commitSha,
      baseSha: inv.parentSha ?? '',
    });
    this.finishChange(decision.outcome, decision.detail, changeFixOutcome(this.store.listPatches(this.id)));
  }

  // ------------------------------------------------------------ mode / models
  private prepareMode() {
    const inv = this.inv;
    const requested = inv.options.requestedMode;
    let mode: ReasoningMode;
    if (requested === 'heuristic') mode = 'heuristic';
    else if (requested === 'replay') mode = 'replay';
    else if (requested === 'live') mode = 'live';
    else mode = this.deps.llm.configured ? 'live' : inv.scenarioId && loadReplay(inv.scenarioId) ? 'replay' : 'heuristic';

    if (mode === 'live' && !this.deps.llm.configured) {
      this.limitations.push('Live mode was requested but NEBIUS_API_KEY is not configured; model stages used deterministic heuristics.');
      mode = 'heuristic';
    }
    if (mode === 'replay') {
      this.replay = inv.scenarioId ? loadReplay(inv.scenarioId) : null;
      if (!this.replay) {
        this.limitations.push('No recorded model outputs exist for this scenario; model stages used deterministic heuristics.');
        mode = 'heuristic';
      }
    }
    if (mode === 'live' && inv.scenarioId) {
      this.recording = { scenarioId: inv.scenarioId, recordedAt: nowIso(), investigationId: this.id, baseUrl: config.nebius.baseUrl, steps: {} };
    }
    this.update({ mode });
  }

  /** Runs one model stage according to the investigation's mode, with logging and fallback. */
  private async modelStep<T>(args: {
    step: string;
    role: ModelRole;
    system: string;
    user: string;
    schemaName: string;
    jsonSchema: Record<string, unknown>;
    validator: ZodType<T, ZodTypeDef, unknown>;
    maxTokens: number;
    fallback: (() => T) | null;
  }): Promise<{ data: T; origin: Origin; model: string; promptTokens?: number | null; completionTokens?: number | null } | null> {
    const mode = this.inv.mode;
    const started = nowIso();
    if (mode === 'replay' && this.replay) {
      const rec = this.replay.steps[args.step];
      const parsed = rec ? args.validator.safeParse(rec.output) : null;
      if (rec && parsed?.success) {
        this.store.addModelCall({
          id: newId('mc'), investigationId: this.id, step: args.step, role: args.role, model: rec.model, status: 'replay',
          startedAt: started, durationMs: 0, inputChars: args.system.length + args.user.length, promptTokens: null, completionTokens: null, attempts: 0,
          error: `Replayed output recorded ${rec.recordedAt}`,
        });
        this.update({ modelsUsed: { ...this.inv.modelsUsed, [args.step]: `${rec.model} (replay)` } });
        return { data: parsed.data, origin: 'replay', model: rec.model };
      }
    }
    if (mode === 'live') {
      let model = 'unresolved';
      try {
        if (!this.budget.take()) throw new ModelError(`Model call budget (${this.budget.max}) exhausted`, 'budget');
        const models = await this.deps.llm.listModels();
        model = models[args.role] ?? models.reasoning ?? models.triage ?? '';
        if (!model) throw new ModelError('No Nemotron model is available in this Token Factory account', 'config');
        const res = await this.deps.llm.chatJson({ role: args.role, model, system: args.system, user: args.user, schemaName: args.schemaName, jsonSchema: args.jsonSchema, validator: args.validator, maxTokens: args.maxTokens });
        this.store.addModelCall({
          id: newId('mc'), investigationId: this.id, step: args.step, role: args.role, model, status: 'ok', startedAt: started,
          durationMs: res.durationMs, inputChars: res.inputChars, promptTokens: res.promptTokens, completionTokens: res.completionTokens, attempts: res.attempts,
          error: res.responseFormat !== 'json_schema' ? `response_format degraded to ${res.responseFormat}` : null,
        });
        this.update({ modelsUsed: { ...this.inv.modelsUsed, [args.step]: model } });
        if (this.recording) this.recording.steps[args.step] = { model, output: res.data, recordedAt: nowIso() };
        return { data: res.data, origin: 'model', model, promptTokens: res.promptTokens, completionTokens: res.completionTokens };
      } catch (err) {
        const e = err as ModelError;
        this.store.addModelCall({
          id: newId('mc'), investigationId: this.id, step: args.step, role: args.role, model, status: e.kind === 'invalid_output' ? 'invalid' : 'error',
          startedAt: started, durationMs: Date.now() - Date.parse(started), inputChars: args.system.length + args.user.length, promptTokens: null, completionTokens: null,
          attempts: e.attempts ?? 1, error: e.message.slice(0, 500),
        });
        this.limitations.push(`${args.step} model call failed (${e.message.slice(0, 160)}); ${args.fallback ? 'used deterministic heuristics instead' : 'step skipped'}.`);
      }
    }
    if (!args.fallback) return null;
    this.update({ modelsUsed: { ...this.inv.modelsUsed, [args.step]: 'heuristic (no model)' } });
    return { data: args.fallback(), origin: 'heuristic', model: 'heuristic' };
  }

  // ------------------------------------------------------------ 2. hypotheses
  private async formHypotheses(): Promise<Hypothesis[]> {
    const inv = this.inv;
    const excerpts = selectExcerpts(this.intake.log, Math.min(config.nebius.maxInputChars, 60_000));
    const lines = splitLines(this.intake.log).map(cleanLine);
    const res = (await this.modelStep<TriageOutput>({
      step: 'triage',
      role: 'triage',
      system: TRIAGE_SYSTEM,
      user: triagePrompt({ inv, facts: this.facts, excerpts, diff: this.intake.diff }),
      schemaName: 'alibi_triage',
      jsonSchema: TRIAGE_JSON_SCHEMA,
      validator: TriageSchema,
      maxTokens: 3000,
      fallback: () => heuristicTriage(this.facts, this.intake.diff, lines),
    }))!;
    const triage = res.data;
    this.triageQueries = triage.search_queries;
    this.triageDeps = triage.implicated_dependencies.map((d) => d.name);

    const diffText = this.intake.diff?.diff ?? '';
    const check = (items: Array<{ quote: string; line?: number }>): EvidenceRef[] =>
      items.map((it) => {
        const v = verifyQuote(this.intake.log, it.quote, it.line);
        const inDiff = !v.verified && it.quote.length >= 6 && diffText.includes(it.quote.trim());
        return { text: it.quote, logLine: v.verified ? v.line : it.line ?? null, verified: v.verified || inDiff };
      });

    const hyps: Hypothesis[] = triage.hypotheses.map((h, i) => ({
      id: newId('hyp'),
      investigationId: this.id,
      key: `H${i + 1}`,
      cause: h.cause,
      category: h.category,
      origin: res.origin,
      supporting: check(h.supporting_evidence),
      contradicting: check(h.contradicting_evidence),
      prior: h.prior,
      status: 'open',
      assessment: h.heuristic_confidence !== undefined ? `Model prior (heuristic, uncalibrated): ${Math.round(h.heuristic_confidence * 100)}%` : null,
      nextExperiment: h.next_experiment || null,
      rank: i,
      requested: h.experiments,
    } as Hypothesis & { requested: string[] }));
    for (const h of hyps) {
      this.store.addHypothesis(h);
      const unverified = [...h.supporting, ...h.contradicting].filter((e) => !e.verified).length;
      this.evidence({
        kind: 'model_hypothesis',
        title: `${h.key}: ${h.cause}`,
        detail: [
          `Category: ${h.category}; prior: ${h.prior}.`,
          h.supporting.length ? `Cited support: ${h.supporting.map((s) => `"${s.text}"${s.logLine ? ` (line ${s.logLine})` : ''}${s.verified ? '' : ' [not found in log]'}`).join('; ')}` : 'No cited support.',
          unverified ? `${unverified} cited quote(s) could not be found in the log or diff.` : '',
        ].filter(Boolean).join('\n'),
        hypothesisKey: h.key, experimentId: null, sourceId: null, effect: null,
        provenance: { type: 'model', ref: res.origin === 'heuristic' ? 'heuristic rules' : `${res.model}${res.origin === 'replay' ? ' (replay)' : ''}` },
      });
    }
    this.update({ summary: triage.summary, failureSignature: this.facts.signature || triage.failure_signature });
    this.pushVerdict('Hypotheses formed', null, `${hyps.length} competing hypotheses; no experiment has run yet.`);
    return hyps;
  }
  private triageQueries: string[] = [];
  private triageDeps: string[] = [];

  private pushVerdict(stage: string, verdict: Investigation['verdict'], note: string, label: Investigation['verdictHistory'][number]['confidence'] = 'none') {
    const inv = this.inv;
    this.update({ verdictHistory: [...inv.verdictHistory, { at: nowIso(), stage, verdict, confidence: label, note }] });
  }

  // ------------------------------------------------------------ 3. plan
  private selection(): TestSelection {
    const f = this.facts;
    if (f.compileErrors.length) {
      // TypeScript: re-run the compiler step CI ran. Go: `go build ./...`, unless a package's tests did not build.
      if (f.framework === 'jest' && f.compileTool === 'tsc') return { check: f.tsBuild ? 'build' : 'typecheck' };
      if (f.framework === 'go' && !f.goTestBuildFailed) return { check: 'build' };
      return {};
    }
    if (f.framework === 'go') {
      // Log-derived Go test names select by -run across all packages; the package import path is not trusted as a directory.
      return f.failingTests.length === 1 ? { name: f.failingTests[0].name } : {};
    }
    if (f.framework === 'maven') {
      const t = f.failingTests[0];
      if (!t) return {};
      const [cls, method] = t.name.split('#');
      return f.failingTests.length === 1 ? { file: cls, name: method } : { file: cls };
    }
    const file = f.failingTests[0]?.file ?? f.failingFiles[0];
    if (!file) return {};
    const inFile = f.failingTests.filter((t) => t.file === file);
    return inFile.length === 1 ? { file, name: inFile[0].name } : { file };
  }

  private async plan(hyps: Hypothesis[]): Promise<Array<{ exp: Experiment; selection: TestSelection; seeds: Array<number | undefined>; sha: string }>> {
    const inv = this.inv;
    const docker = await checkDocker();
    const sel = this.selection();
    const selText = describeSelection(this.facts.framework, sel);
    const requested = new Set(hyps.flatMap((h) => (h as Hypothesis & { requested?: string[] }).requested ?? []));
    const categories = new Set(hyps.map((h) => h.category));
    const firstFor = (cats: Classification[]) => hyps.find((h) => cats.includes(h.category))?.key ?? hyps[0]?.key ?? null;
    const out: Array<{ exp: Experiment; selection: TestSelection; seeds: Array<number | undefined>; sha: string; skipped?: boolean }> = [];
    const skip = (e: Experiment) => out.push({ exp: { ...e, status: 'skipped', backend: 'none', observation: e.reason }, selection: {}, seeds: [], sha: '', skipped: true });
    const repeat = Math.max(2, Math.min(inv.options.repeat, 30));
    const ciSeed = this.facts.jestSeed ?? undefined;
    const isCompile = this.facts.compileErrors.length > 0;

    const mk = (kind: ExperimentKind, title: string, reason: string, hyp: string | null, sha: string | null, attempts: number): Experiment => ({
      id: newId('exp'), investigationId: this.id, hypothesisKey: hyp, kind, title, reason, status: 'queued',
      backend: kind === 'external_search' ? 'tavily' : 'docker', command: null, environment: null, commitSha: sha,
      testSelection: kind === 'external_search' ? null : selText, plannedAttempts: attempts, startedAt: null, finishedAt: null,
      durationMs: null, result: null, observation: null, effect: null, patchId: null,
    });

    const runnable = SANDBOX_FRAMEWORKS.includes(this.facts.framework);
    // pytest, Go, and TypeScript: the checkout's layout decides support, before anything is installed or run.
    if (docker.ok && runnable) this.unsupportedLayout = await this.checkoutLayoutProblem();
    if (!docker.ok || !runnable || this.unsupportedLayout) {
      const why = !docker.ok
        ? `Sandbox runner unavailable: ${docker.detail}`
        : this.unsupportedLayout
          ? `${this.unsupportedLayout} No dependencies were installed and no tests were run. Conclusions rest on log and diff analysis.`
          : `Sandbox experiments are not supported for ${this.facts.framework === 'unknown' ? 'this test framework' : `"${this.facts.framework}"`} yet (supported: ${SUPPORTED_TEXT}). Conclusions rest on log and diff analysis.`;
      this.limitations.push(why);
      const e = mk('reproduce', 'Reproduce the failure', why, hyps[0]?.key ?? null, inv.commitSha, 0);
      skip(e);
      this.evidence({ kind: 'assumption', title: 'No experiments executed', detail: `${why} Conclusions rest on log and diff analysis only.`, hypothesisKey: null, experimentId: e.id, sourceId: null, effect: null, provenance: { type: 'policy', ref: 'runner' } });
    } else {
      out.push({
        exp: mk('reproduce', 'Reproduce the failure', ciSeed !== undefined
          ? `Re-run ${selText} at the failing commit in a clean, offline sandbox using the exact Jest seed from CI (${ciSeed}).`
          : `Re-run ${selText} at the failing commit in a clean, offline sandbox.`, firstFor(['code_regression', 'dependency_regression']), inv.commitSha, 1),
        selection: sel, seeds: [ciSeed], sha: inv.commitSha,
      });
      if (!isCompile && (categories.has('flaky_test') || categories.has('infrastructure') || requested.has('repeat'))) {
        out.push({
          exp: this.facts.framework === 'go'
            ? mk('repeat', `Run the failing test ${repeat}× with varied -shuffle seeds`, `Measures intermittency at the same commit. Each run is a separate offline \`go test -count=1\` process (no test cache) with a replayable -shuffle seed for test order; the seed does not fix timing or math/rand inside tests. ${repeat} runs bound, but do not pin down, the true failure rate.`, firstFor(['flaky_test']), inv.commitSha, repeat)
            : this.facts.framework === 'pytest'
            ? mk('repeat', `Run the failing test ${repeat}× in fresh processes`, `Measures intermittency at the same commit. Each run is a separate offline pytest process; pytest has no seed option, so runs are independent rather than replayable. ${repeat} runs bound, but do not pin down, the true failure rate.`, firstFor(['flaky_test']), inv.commitSha, repeat)
            : mk('repeat', `Run the failing test ${repeat}× with varied seeds`, `Measures intermittency at the same commit. Seeds are attempt × 65537 so every run is replayable. ${repeat} runs bound, but do not pin down, the true failure rate.`, firstFor(['flaky_test']), inv.commitSha, repeat),
          selection: sel, seeds: Array.from({ length: repeat }, (_, i) => attemptSeed(i + 1)), sha: inv.commitSha,
        });
      } else if (isCompile) {
        skip(mk('repeat', 'Repeat runs', 'Skipped: a compilation error is deterministic; repeating cannot change the outcome.', null, inv.commitSha, 0));
      }
      if (inv.parentSha) {
        const n = isCompile ? 1 : 3;
        const seeds = isCompile ? [undefined] : [ciSeed, attemptSeed(1), attemptSeed(2)].slice(0, n);
        out.push({
          exp: mk('compare_parent', inv.source === 'change' ? 'Compare against the base revision' : 'Compare against the parent commit', `Runs the same selection at the ${inv.source === 'change' ? 'base revision' : 'parent'} ${inv.parentSha.slice(0, 12)}${ciSeed !== undefined ? ` (first run with the CI seed ${ciSeed})` : ''}. If the parent passes, the failing commit introduced the failure.`, firstFor(['code_regression', 'dependency_regression']), inv.parentSha, n),
          selection: sel, seeds, sha: inv.parentSha,
        });
      } else {
        this.limitations.push('Parent commit unknown; could not compare.');
      }
    }

    const infraLikely = hyps.some((h) => h.category === 'infrastructure' && h.prior !== 'low');
    const external = categories.has('dependency_regression') || categories.has('external_outage') || infraLikely || (this.intake.diff?.dependencyChanges.length ?? 0) > 0;
    if (external || requested.has('external_search')) {
      const e = mk('external_search', 'Search for external evidence', tavilyConfigured()
        ? 'A hypothesis implicates an external dependency or service; search release notes, issues, and status pages for corroboration.'
        : 'Skipped: TAVILY_API_KEY is not configured.', firstFor(['dependency_regression', 'external_outage', 'infrastructure']), null, 0);
      if (tavilyConfigured()) out.push({ exp: e, selection: {}, seeds: [], sha: '' });
      else skip(e);
    }
    for (const p of out) this.store.addExperiment(p.exp);
    return out.filter((p) => !p.skipped);
  }

  private unsupportedLayout: string | null = null;

  /** Reads the failing commit's project layout (pytest, Go, TypeScript) from a throwaway checkout; null when supported. */
  private async checkoutLayoutProblem(): Promise<string | null> {
    if (this.facts.framework !== 'pytest' && this.facts.framework !== 'go' && this.facts.framework !== 'jest') return null;
    const dir = join(this.workRoot, 'layout-check');
    try {
      await checkout(this.intake.source, this.inv.commitSha, dir);
      return layoutProblem(this.facts.framework, dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // ------------------------------------------------------------ 4. execute
  private async execute(planned: Awaited<ReturnType<InvestigationRun['plan']>>, hyps: Hypothesis[]) {
    // Change verifications already prepared workspaces for both revisions while collecting.
    this.pool ??= new WorkspacePool(this.intake.source, this.workRoot, this.facts.framework);
    for (const p of planned) {
      if (p.exp.kind === 'external_search') {
        await this.runSearch(p.exp);
        continue;
      }
      this.stage(`Running experiment: ${p.exp.title}`);
      const ws = await this.pool.get(p.sha);
      const exp = await runTestExperiment({ store: this.store, experiment: p.exp, workspace: ws, selection: p.selection, seeds: p.seeds });
      this.recordExperimentEvidence(exp, hyps);
    }
  }

  private recordExperimentEvidence(exp: Experiment, hyps: Hypothesis[]) {
    if (exp.status === 'error') {
      this.store.updateExperiment(exp.id, { effect: 'The experiment could not run; it does not change the assessment.' });
      this.evidence({ kind: 'experiment_result', title: `${exp.title}: could not run`, detail: exp.observation ?? '', hypothesisKey: exp.hypothesisKey, experimentId: exp.id, sourceId: null, effect: 'neutral', provenance: { type: 'experiment', ref: exp.id } });
      return;
    }
    const observation = summarizeAttempts(exp);
    const effects = hyps.map((h) => ({ h, ...experimentEffect(exp, h) }));
    const effectText = effects.filter((e) => e.effect !== 'neutral').map((e) => `${e.effect === 'supports' ? 'Supports' : 'Contradicts'} ${e.h.key}: ${e.why}`).join('\n') || 'Does not discriminate between the hypotheses.';
    this.store.updateExperiment(exp.id, { observation, effect: effectText });
    this.evidence({
      kind: 'experiment_result',
      title: `${exp.title} @ ${exp.commitSha?.slice(0, 12)}: ${observation.split(' —')[0]}`,
      detail: `${observation}\nCommand: ${(exp.command ?? []).join(' ')}`,
      hypothesisKey: exp.hypothesisKey, experimentId: exp.id, sourceId: null, effect: null,
      provenance: { type: 'experiment', ref: exp.id },
    });
    for (const e of effects.filter((x) => x.effect !== 'neutral')) {
      this.evidence({
        kind: 'inference',
        title: `${e.effect === 'supports' ? 'Supports' : 'Contradicts'} ${e.h.key}`,
        detail: e.why,
        hypothesisKey: e.h.key, experimentId: exp.id, sourceId: null, effect: e.effect,
        provenance: { type: 'policy', ref: 'experiment-effect rules' },
      });
    }
  }

  private async runSearch(exp: Experiment, explicitQueries?: string[]) {
    this.stage('Searching external sources (Tavily)');
    const started = Date.now();
    this.store.updateExperiment(exp.id, { status: 'running', startedAt: nowIso() });
    const queries = explicitQueries ?? this.searchQueries();
    const hints = [...this.triageDeps, ...(this.intake.diff?.dependencyChanges.map((d) => d.name) ?? [])];
    let found = 0;
    let official = 0;
    const errors: string[] = [];
    for (const q of queries) {
      try {
        const res = await tavilySearch(q, { maxResults: 5 });
        for (const r of res.results.slice(0, 4)) {
          const off = isOfficialSource(r.url, hints);
          const src = this.store.addSource({
            id: newId('src'), investigationId: this.id, hypothesisKey: exp.hypothesisKey, query: q, title: r.title, url: r.url,
            domain: (() => { try { return new URL(r.url).hostname; } catch { return ''; } })(),
            excerpt: r.content.slice(0, 700), score: r.score, publishedDate: r.publishedDate, official: off,
            relevance: off ? 'Primary source (official domain or project repository).' : 'Secondary source; treat as a lead.',
            retrievedAt: nowIso(),
          });
          found++;
          if (off) official++;
          this.evidence({
            kind: 'external_source',
            title: r.title,
            detail: `${r.content.slice(0, 400)}\n\nQuery: "${q}"`,
            hypothesisKey: exp.hypothesisKey, experimentId: exp.id, sourceId: src.id, effect: null,
            provenance: { type: 'web', url: r.url, ref: res.requestId ?? undefined },
          });
        }
      } catch (err) {
        errors.push(`"${q}": ${(err as Error).message}`);
      }
    }
    const observation = `${queries.length} Tavily ${queries.length === 1 ? 'query' : 'queries'} returned ${found} result(s), ${official} from primary sources.${errors.length ? ` Errors: ${errors.join('; ')}` : ''}`;
    this.store.updateExperiment(exp.id, {
      status: errors.length === queries.length && queries.length ? 'error' : 'passed',
      command: queries.map((q) => `tavily.search("${q}")`),
      finishedAt: nowIso(),
      durationMs: Date.now() - started,
      observation,
      effect: found ? 'Search results are leads that can corroborate a hypothesis; they are not proof on their own.' : 'No external corroboration found.',
      environment: { backend: 'tavily', endpoint: 'https://api.tavily.com/search', search_depth: 'basic' },
    });
  }

  private searchQueries(): string[] {
    const qs: string[] = [];
    const clean = (q: string) => q.replace(/\s+/g, ' ').trim().slice(0, 200);
    for (const dep of this.intake.diff?.dependencyChanges ?? []) {
      const symbol = this.facts.compileErrors[0]?.symbol?.replace(/^method\s+/, '').replace(/\(.*$/, '');
      const loc = this.facts.compileErrors[0]?.location?.replace(/^class\s+/, '');
      qs.push(clean(`${dep.name} ${dep.to} release notes ${symbol ? `${loc ? `${loc}.` : ''}${symbol} removed` : 'breaking changes'}`));
    }
    for (const q of this.triageQueries) if (q.length >= 8) qs.push(clean(q));
    return [...new Set(qs)].slice(0, 3);
  }

  // ------------------------------------------------------------ 4b. agent loop (ALIBI_LOOP=1)
  private loopResult: LoopResult | null = null;
  private loopStopDetail = '';
  private loopSeed = 100;

  /** Test selections the model may refer to by ID. Derived only from parsed log facts. */
  private loopSelections(): SelectionOption[] {
    const fw = this.facts.framework;
    const out: SelectionOption[] = [];
    const add = (sel: TestSelection) => {
      const v = validateSelection(fw, sel);
      if (out.some((o) => JSON.stringify(o.selection) === JSON.stringify(v))) return;
      out.push({ id: `T${out.length + 1}`, label: describeSelection(fw, v), selection: v });
    };
    add(this.selection());
    add({});
    for (const t of this.facts.failingTests.slice(0, 4)) {
      if (fw === 'maven') {
        const [file, name] = t.name.split('#');
        add({ file, name });
      } else if (fw === 'go') add({ name: t.name });
      else if (t.file) add({ file: t.file, name: t.name });
    }
    return out;
  }

  private toObservation(e: Experiment, step: LoopObservation['step'], tool: string, commit: string, selection: string): LoopObservation {
    const r = e.result;
    const failed = r?.attempts.find((a) => !a.passed);
    return {
      step,
      tool,
      commit,
      selection,
      passes: r?.passes ?? 0,
      failures: r?.failures ?? 0,
      exitCodes: r?.attempts.map((a) => a.exitCode) ?? [],
      summary: e.backend === 'tavily' ? e.observation ?? '' : `${summarizeAttempts(e)}${e.status === 'error' ? ` (could not run: ${(e.observation ?? '').slice(0, 200)})` : ''}`,
      outputTail: (failed?.outputTail ?? '').slice(-1500),
    };
  }

  /** Bounded model-driven loop. Policy, budgets, and stop rules are enforced in agentLoop.ts. */
  private async iterate(hyps: Hypothesis[]) {
    const inv = this.inv;
    const L = config.agentLoop;
    const runnable = Boolean(this.pool) && SANDBOX_FRAMEWORKS.includes(this.facts.framework) && !this.unsupportedLayout && (await checkDocker()).ok;
    const selections = runnable ? this.loopSelections() : [];
    const ctx = { selections, hasParent: Boolean(inv.parentSha), searchEnabled: tavilyConfigured() };
    const state = { runsUsed: 0, searchesUsed: 0, seen: new Set<string>() };

    // The deterministic baseline is the loop's starting evidence and counts for duplicate detection.
    const baseline: LoopObservation[] = [];
    for (const e of this.store.listExperiments(this.id)) {
      if (e.kind === 'external_search' && e.status === 'passed') {
        for (const c of e.command ?? []) {
          const q = /tavily\.search\("(.*)"\)$/.exec(c)?.[1];
          if (q) state.seen.add(actionKey({ tool: 'search', query: q }));
        }
        baseline.push(this.toObservation(e, 'baseline', 'search', '-', 'baseline queries'));
        continue;
      }
      if (e.backend !== 'docker' || !e.result) continue;
      const commit = e.commitSha === inv.parentSha ? 'parent' : 'failing';
      const n = e.result.attempts.length;
      const action: ApprovedAction = n > 1 ? { tool: 'repeat', commit, selectionId: 'T1', runs: n } : { tool: 'reproduce', commit, selectionId: 'T1', runs: 1 };
      state.seen.add(actionKey(action));
      baseline.push(this.toObservation(e, 'baseline', e.kind, commit, 'T1'));
    }

    const record = (title: string, detail: string, kind: 'inference' | 'observed_fact', provenance: { type: 'model' | 'policy'; ref: string }, hypothesisKey: string | null = null) =>
      this.evidence({ kind, title, detail, hypothesisKey, experimentId: null, sourceId: null, effect: null, provenance });

    if (!selections.length && !ctx.searchEnabled) {
      this.loopResult = { iterations: 0, modelCalls: 0, promptTokens: 0, completionTokens: 0, executed: 0, rejected: 0, elapsedMs: 0, stopReason: 'no_allowed_action' };
      this.loopStopDetail = STOP_REASON_TEXT.no_allowed_action;
      record('Agent loop stopped: no allowed action', `${STOP_REASON_TEXT.no_allowed_action} (no runnable test selection and no search available).`, 'inference', { type: 'policy', ref: 'agent-loop limits' });
      return;
    }

    let lastProposal: NextActionOutput['action'] | null = null;
    let lastDecision: NextActionOutput | null = null;
    const known = new Set(hyps.map((h) => h.key));
    const mk = (kind: ExperimentKind, title: string, reason: string, sha: string | null, selection: TestSelection | null, attempts: number, backend: Experiment['backend']): Experiment => ({
      id: newId('exp'), investigationId: this.id,
      hypothesisKey: lastDecision?.hypothesis_updates.find((u) => u.status !== 'unchanged' && known.has(u.id))?.id ?? inv.primaryHypothesis ?? hyps[0]?.key ?? null,
      kind, title, reason, status: 'queued', backend, command: null, environment: null, commitSha: sha,
      testSelection: selection ? describeSelection(this.facts.framework, selection) : null, plannedAttempts: attempts,
      startedAt: null, finishedAt: null, durationMs: null, result: null, observation: null, effect: null, patchId: null,
    });

    this.loopResult = await runAgentLoop(
      ctx,
      { maxIterations: L.maxIterations, maxModelCalls: L.maxModelCalls, maxTokens: L.maxTokens, maxMs: L.maxMs, maxRuns: L.maxRuns, maxRunsPerAction: L.maxRunsPerAction, maxSearches: L.maxSearches },
      {
        now: () => Date.now(),
        decide: async (input) => {
          const res = await this.modelStep({
            step: `loop-${input.iteration}`,
            role: 'reasoning',
            system: LOOP_SYSTEM,
            user: loopPrompt({
              hypotheses: hyps.map((h) => ({ key: h.key, cause: h.cause, category: h.category })),
              selections: selections.map(({ id, label }) => ({ id, label })),
              hasParent: ctx.hasParent,
              searchEnabled: ctx.searchEnabled,
              observations: input.observations,
              remaining: input.remaining,
            }),
            schemaName: 'alibi_next_action',
            jsonSchema: NEXT_ACTION_JSON_SCHEMA,
            validator: NextActionSchema,
            maxTokens: 1500,
            fallback: null,
          });
          if (!res) {
            if (this.inv.mode === 'live') throw new Error('The decision call failed; see the Model calls tab.');
            return null;
          }
          lastProposal = res.data.action ?? null;
          return { data: res.data, model: res.origin === 'replay' ? `${res.model} (replay)` : res.model, promptTokens: res.promptTokens ?? null, completionTokens: res.completionTokens ?? null };
        },
        execute: async (a, iteration) => {
          const why = [`Agent step ${iteration}.`, lastProposal?.rationale, lastProposal?.prediction && `Prediction: ${lastProposal.prediction}`].filter(Boolean).join(' ');
          if (a.tool === 'search') {
            const exp = this.store.addExperiment(mk('external_search', `Agent step ${iteration}: search`, why, null, null, 0, 'tavily'));
            await this.runSearch(exp, [a.query]);
            const done = this.store.getExperiment(exp.id)!;
            const titles = this.store.listSources(this.id).filter((s) => s.query === a.query).slice(0, 3).map((s) => `- ${s.official ? '[primary] ' : ''}${s.title}: ${s.excerpt.slice(0, 200)}`).join('\n');
            return { observation: { ...this.toObservation(done, iteration, 'search', '-', a.query), outputTail: titles }, experimentId: done.id };
          }
          const sha = a.commit === 'parent' ? inv.parentSha! : inv.commitSha;
          const opt = selections.find((s) => s.id === a.selectionId)!;
          const kind: ExperimentKind = a.commit === 'parent' ? 'compare_parent' : a.tool === 'repeat' ? 'repeat' : 'reproduce';
          const label = a.tool === 'repeat' ? `repeat ${a.runs}×` : a.tool === 'run_test' ? 'run test' : 'reproduce';
          const exp = this.store.addExperiment(mk(kind, `Agent step ${iteration}: ${label} on the ${a.commit} commit`, why, sha, opt.selection, a.runs, 'docker'));
          this.stage(`Agent step ${iteration}: ${label}`);
          const seeds = Array.from({ length: a.runs }, () => attemptSeed(++this.loopSeed));
          const done = await runTestExperiment({ store: this.store, experiment: exp, workspace: await this.pool.get(sha), selection: opt.selection, seeds });
          this.recordExperimentEvidence(done, hyps);
          return { observation: this.toObservation(this.store.getExperiment(done.id)!, iteration, a.tool, a.commit, a.selectionId), experimentId: done.id };
        },
        record: (ev) => {
          if (ev.type === 'decision') {
            lastDecision = ev.data;
            const d = ev.data;
            const a = d.decision === 'conclude' ? null : d.action;
            const updates = d.hypothesis_updates.filter((u) => u.status !== 'unchanged').map((u) => `${u.id} ${u.status}: ${u.reason}`);
            record(
              `Agent step ${ev.iteration}: ${a ? `${a.tool} ${JSON.stringify(a.args).slice(0, 120)}` : 'conclude'}`,
              [a?.prediction && `Prediction: ${a.prediction}`, a?.rationale && `Rationale: ${a.rationale}`, d.conclusion && `Conclusion: ${d.conclusion}`, ...updates].filter(Boolean).join('\n') || 'No rationale given.',
              'inference',
              { type: 'model', ref: ev.model },
              d.hypothesis_updates.find((u) => u.status !== 'unchanged' && known.has(u.id))?.id ?? null,
            );
          } else if (ev.type === 'rejected') {
            record(`Agent step ${ev.iteration} rejected by policy`, `${ev.reason}\nProposed: ${JSON.stringify({ tool: ev.proposal.tool, args: ev.proposal.args }).slice(0, 300)}`, 'observed_fact', { type: 'policy', ref: 'agent-loop policy' });
          } else if (ev.type === 'stopped') {
            this.loopStopDetail = ev.detail;
            record(`Agent loop stopped: ${ev.reason.replace(/_/g, ' ')}`, ev.detail, 'inference', { type: 'policy', ref: 'agent-loop limits' });
          }
        },
      },
      baseline,
      state,
    );
  }

  // ------------------------------------------------------------ 5. weigh
  private effectTally(hyps: Hypothesis[]): Map<string, { s: number; c: number }> {
    const tally = new Map<string, { s: number; c: number }>();
    for (const ev of this.store.listEvidence(this.id)) {
      if (ev.kind !== 'inference' || !ev.hypothesisKey || !ev.effect) continue;
      const t = tally.get(ev.hypothesisKey) ?? { s: 0, c: 0 };
      if (ev.effect === 'supports') t.s++;
      if (ev.effect === 'contradicts') t.c++;
      tally.set(ev.hypothesisKey, t);
    }
    for (const h of hyps) if (!tally.has(h.key)) tally.set(h.key, { s: 0, c: 0 });
    return tally;
  }

  private async weigh(): Promise<VerdictOutput> {
    const inv = this.inv;
    const hyps = this.store.listHypotheses(this.id);
    const experiments = this.store.listExperiments(this.id);
    const sources = this.store.listSources(this.id);
    const d = this.intake.diff;
    const diffSummary = d ? `${d.files.map((f) => f.path).join(', ')}${d.onlyDocs ? ' (documentation only)' : ''}; dependency changes: ${JSON.stringify(d.dependencyChanges.map(({ name, from, to }) => ({ name, from, to })))}` : 'unavailable';
    const tally = this.effectTally(hyps);
    const res = (await this.modelStep<VerdictOutput>({
      step: 'verdict',
      role: 'reasoning',
      system: VERDICT_SYSTEM,
      user: verdictPrompt({ inv, hypotheses: hyps, experiments, sources, diffSummary }),
      schemaName: 'alibi_verdict',
      jsonSchema: VERDICT_JSON_SCHEMA,
      validator: VerdictSchema,
      maxTokens: 2500,
      fallback: () => heuristicVerdict(hyps, experiments, tally),
    }))!;
    const v = res.data;

    // Deterministic guard: "supported" requires at least one experiment whose result the effect
    // rules recorded as supporting this hypothesis. A model's word alone is not support.
    for (const h of hyps) {
      const mv = v.hypotheses.find((x) => x.id === h.key);
      const t = tally.get(h.key)!;
      const { status, assessment } = guardHypothesisStatus(mv?.status ?? (t.c ? 'refuted' : t.s ? 'supported' : 'inconclusive'), mv?.assessment ?? null, t);
      this.store.updateHypothesis(h.id, { status, assessment });
    }
    const conf = assessConfidence({ classification: v.classification, experiments, patches: [], dependencyChanged: (d?.dependencyChanges.length ?? 0) > 0, docsOnlyChange: d?.onlyDocs ?? false, corroboratingSources: sources.filter((s) => s.official).length });
    const rec = reconcileVerdict(v.verdict, conf);
    this.update({
      classification: v.classification,
      verdict: rec.verdict,
      summary: v.summary,
      primaryHypothesis: v.primary_hypothesis,
      recommendedAction: v.recommended_action,
      remediationType: v.remediation_type,
      confidence: conf,
    });
    this.evidence({
      kind: 'inference',
      title: `Verdict after experiments: ${rec.verdict} — ${v.classification.replace(/_/g, ' ')}`,
      detail: `${v.summary}${rec.adjusted ? `\n\n${PRODUCT_NAME} policy: ${rec.reason}` : ''}`,
      hypothesisKey: v.primary_hypothesis, experimentId: null, sourceId: null, effect: null,
      provenance: { type: 'model', ref: res.origin === 'heuristic' ? 'heuristic rules' : `${res.model}${res.origin === 'replay' ? ' (replay)' : ''}` },
    });
    const observed = experiments
      .filter((e) => e.result && e.backend === 'docker')
      .map((e) => `${({ reproduce: 'reproduction', repeat: 'repeated runs', compare_parent: 'parent commit' } as Record<string, string>)[e.kind] ?? e.kind} ${e.result!.failures}/${e.result!.attempts.length} failed`)
      .join('; ');
    const basisNote = observed ? `Observed — ${observed}.` : 'No experiment produced a result.';
    this.pushVerdict('Experiments weighed', rec.verdict, `${basisNote} Evidence rubric: ${conf.label}.${rec.adjusted ? ` ${rec.reason}` : ''}`, conf.label);
    for (const l of v.limitations) this.limitations.push(`Before fix validation: ${l}`);
    return v;
  }

  // ------------------------------------------------------------ 6. remediate
  private async remediate(v: VerdictOutput) {
    const inv = this.inv;
    const docker = await checkDocker();
    const executed = this.store.listExperiments(this.id).some((e) => e.backend === 'docker' && e.result);
    if (!docker.ok || !this.pool || !executed) {
      if (v.classification === 'infrastructure' || v.classification === 'external_outage') this.update({ remediationType: 'retry' });
      return;
    }
    const d = this.intake.diff;
    const reproduce = this.store.listExperiments(this.id).find((e) => e.kind === 'reproduce' && e.result);
    const repeat = this.store.listExperiments(this.id).find((e) => e.kind === 'repeat' && e.result);
    const failingWs = await this.pool.get(inv.commitSha);
    const read = (p: string) => (existsSync(join(failingWs.dir, p)) ? readFileSync(join(failingWs.dir, p), 'utf8') : null);
    const candidates: CandidateEdit[] = [];
    let modelAllowed: string[] | undefined;
    let patchUser = '';
    let retried = false;

    if (v.classification === 'infrastructure' || v.classification === 'external_outage') {
      this.update({ remediationType: 'retry' });
      return;
    }
    if (v.classification === 'flaky_test') {
      const t = this.facts.failingTests[0];
      // Go logs name the test, not its file: look up the declaring _test.go file in the checkout.
      const file = t?.file ?? (t && this.facts.framework === 'go' ? findGoTestFile(failingWs.dir, t.name) ?? undefined : undefined);
      const content = file ? read(file) : null;
      if (t && file && content) {
        const r = repeat?.result;
        const summary = r ? `failed ${r.failures}/${r.attempts.length} seeded runs at the same commit` : 'intermittent failure';
        const q = quarantineCandidate({ testFile: file, testFullName: t.name, content, investigationId: this.id, failureSummary: summary });
        if (q) candidates.push(q);
      }
    }
    if (v.classification === 'dependency_regression' && d) {
      const pin = pinCandidate(d, read);
      if (pin) candidates.push(pin);
    }
    if ((v.classification === 'code_regression' || v.classification === 'dependency_regression') && d && reproduce) {
      // Model-written targeted fix (live/replay only).
      const files = patchContextFiles(this.facts, d)
        .map((p) => ({ path: p, content: read(p) }))
        .filter((f): f is { path: string; content: string } => f.content !== null && f.content.length < 20_000);
      if (files.length && this.inv.mode !== 'heuristic') {
        const primary = this.store.listHypotheses(this.id).find((h) => h.key === v.primary_hypothesis);
        patchUser = patchPrompt({ signature: this.facts.signature, failureOutput: reproduce.result!.attempts[0]?.outputTail ?? '', diff: d.diff, files: files.map((f) => ({ ...f, readOnly: isTestFile(f.path) })), rootCause: primary?.cause ?? v.summary });
        const res = await this.modelStep({
          step: 'patch',
          role: 'deep',
          system: PATCH_SYSTEM,
          user: patchUser,
          schemaName: 'alibi_patch',
          jsonSchema: PATCH_JSON_SCHEMA,
          validator: PatchSchema,
          maxTokens: 6000,
          fallback: null,
        });
        if (res) {
          // Test files are context only, for the first patch as for the retry: a fix that makes
          // tests pass by changing what they expect is not a fix.
          modelAllowed = files.map((f) => f.path).filter((p) => !isTestFile(p));
          candidates.unshift({
            title: `Targeted fix by ${res.model.split('/').pop()}${res.origin === 'replay' ? ' (replay)' : ''}`,
            strategy: 'code_patch',
            origin: res.origin,
            rationale: res.data.explanation,
            edits: res.data.files,
          });
        }
      }
      if (v.classification === 'code_regression' && this.intake.repoDir && inv.parentSha) {
        const rev = await revertCandidate(this.intake.repoDir, inv.parentSha, d);
        if (rev) candidates.push(rev);
      }
    }

    for (const [i, cand] of candidates.entries()) {
      const m = await materialize(this.intake.source, inv.commitSha, join(this.workRoot, `scratch-${i}`), this.id, cand, cand.origin === 'model' || cand.origin === 'replay' ? modelAllowed : undefined);
      if (!m.patch) {
        this.limitations.push(`Candidate "${cand.title}" was not usable: ${m.problem}`);
        this.evidence({ kind: 'observed_fact', title: `Candidate rejected: ${cand.title}`, detail: m.problem ?? '', hypothesisKey: v.primary_hypothesis, experimentId: null, sourceId: null, effect: null, provenance: { type: 'policy', ref: 'patch policy' } });
        continue;
      }
      const patch = this.store.addPatch(m.patch);
      const outcome = await this.validatePatch(patch, v.classification);
      // ALIBI_LOOP only: one bounded retry of a model-written fix, given the actual failing output.
      if (config.agentLoop.enabled && !outcome.ok && !retried && patchUser && modelAllowed && (cand.origin === 'model' || cand.origin === 'replay')) {
        retried = true;
        await this.retryPatch(patch, outcome, patchUser, modelAllowed, v, i);
      }
    }
  }

  private patchRetries = 0;

  /** One retry of a failed model-written fix. Failed candidates stay failed; the retry is validated in a fresh sandbox. */
  private async retryPatch(failed: Patch, outcome: { failureOutput: string; summary: string }, baseUser: string, allowed: string[], v: VerdictOutput, i: number) {
    const inv = this.inv;
    this.stage('Retrying the model fix with the actual failure output');
    const res = await this.modelStep({
      step: 'patch-retry',
      role: 'deep',
      system: PATCH_SYSTEM,
      user: patchRetryPrompt(baseUser, { diff: failed.diff, failureOutput: outcome.failureOutput, summary: outcome.summary }),
      schemaName: 'alibi_patch',
      jsonSchema: PATCH_JSON_SCHEMA,
      validator: PatchSchema,
      maxTokens: 6000,
      fallback: null,
    });
    if (!res) return;
    this.patchRetries++;
    const cand: CandidateEdit = {
      title: `Retry: targeted fix by ${res.model.split('/').pop()}${res.origin === 'replay' ? ' (replay)' : ''}`,
      strategy: 'code_patch',
      origin: res.origin,
      rationale: `Second attempt after "${failed.title}" failed validation (${outcome.summary}). ${res.data.explanation}`,
      edits: res.data.files,
    };
    // Test files are excluded from the editable set so a retry cannot make tests pass by changing them.
    const m = await materialize(this.intake.source, inv.commitSha, join(this.workRoot, `scratch-retry-${i}`), this.id, cand, allowed);
    if (!m.patch) {
      this.limitations.push(`Retry candidate was not usable: ${m.problem}`);
      this.evidence({ kind: 'observed_fact', title: `Candidate rejected: ${cand.title}`, detail: m.problem ?? '', hypothesisKey: v.primary_hypothesis, experimentId: null, sourceId: null, effect: null, provenance: { type: 'policy', ref: 'patch policy' } });
      return;
    }
    const patch = this.store.addPatch(m.patch);
    await this.validatePatch(patch, v.classification);
  }

  private async validatePatch(patch: Patch, classification: Classification): Promise<{ ok: boolean; failureOutput: string; summary: string }> {
    const inv = this.inv;
    this.stage(`Validating candidate: ${patch.title}`);
    this.store.updatePatch(patch.id, { status: 'validating' });
    // Checkout → apply candidate → install → test, all in a fresh workspace.
    const ws = await this.pool.fresh(inv.commitSha, `patch-${patch.id.slice(-6)}`, patch.diff);
    const applied = ws.patchApplied ?? { ok: false, detail: 'patch was not applied' };
    if (!applied.ok) {
      this.store.updatePatch(patch.id, { status: 'failed', validation: { summary: `Patch did not apply: ${applied.detail}` } });
      return { ok: false, failureOutput: applied.detail, summary: 'The patch did not apply' };
    }
    const flaky = classification === 'flaky_test';
    const sel = this.selection();
    const targetedSel: TestSelection = flaky ? { file: sel.file } : sel;
    const n = flaky ? Math.max(2, Math.min(inv.options.repeat, 30)) : 3;
    const seeds = Array.from({ length: n }, (_, i) => attemptSeed(i + 1));
    // A compile check (tsc, go build) is not a test run: the regression suite must still run after it.
    const fullSuite = !targetedSel.file && !targetedSel.name && !targetedSel.check;

    const mk = (kind: ExperimentKind, title: string, reason: string, s: TestSelection, attempts: number): Experiment => ({
      id: newId('exp'), investigationId: this.id, hypothesisKey: inv.primaryHypothesis, kind, title, reason, status: 'queued', backend: 'docker',
      command: null, environment: null, commitSha: inv.commitSha, testSelection: `${describeSelection(this.facts.framework, s)} + patch`, plannedAttempts: attempts,
      startedAt: null, finishedAt: null, durationMs: null, result: null, observation: null, effect: null, patchId: patch.id,
    });
    const targeted = this.store.addExperiment(mk('validate_patch', `Validate: ${patch.title}`, flaky
      ? `Runs the affected test file ${n}× with the same seeds that exposed the flake, with the candidate applied.`
      : `Runs the originally failing selection ${n}× with the candidate applied to the failing commit.`, targetedSel, n));
    const t = await runTestExperiment({ store: this.store, experiment: targeted, workspace: ws, selection: targetedSel, seeds });
    let suiteOk = true;
    let suiteId: string | undefined;
    let suiteFailure = '';
    if (!fullSuite && t.status === 'passed') {
      const suite = this.store.addExperiment(mk('regression_suite', `Regression suite: ${patch.title}`, 'Runs the full test suite with the candidate applied, to catch collateral breakage.', {}, 1));
      const s = await runTestExperiment({ store: this.store, experiment: suite, workspace: ws, selection: {}, seeds: [attemptSeed(1)] });
      suiteOk = s.status === 'passed';
      suiteId = s.id;
      suiteFailure = s.result?.attempts.find((a) => !a.passed)?.outputTail ?? '';
      this.store.updateExperiment(s.id, { observation: summarizeAttempts(s), effect: suiteOk ? 'No regressions in the full suite.' : 'The candidate breaks other tests.' });
    }
    const ok = t.status === 'passed' && suiteOk;
    this.store.updateExperiment(t.id, { observation: summarizeAttempts(t), effect: ok ? 'The candidate makes the failing selection pass.' : 'The candidate does not fix the failure.' });
    const summary = ok
      ? `Passed ${t.result!.passes}/${t.result!.attempts.length} targeted runs${fullSuite ? ' (full build and suite)' : ' and the full regression suite'}.`
      : t.status !== 'passed' ? `Targeted runs: ${summarizeAttempts(t)}.` : 'Targeted runs passed but the regression suite failed.';
    this.store.updatePatch(patch.id, { status: ok ? 'validated' : 'failed', validation: { targetedExperimentId: t.id, suiteExperimentId: suiteId ?? t.id, summary } });
    this.evidence({
      kind: 'experiment_result',
      title: `Candidate ${ok ? 'validated' : 'failed validation'}: ${patch.title}`,
      detail: summary,
      hypothesisKey: inv.primaryHypothesis, experimentId: t.id, sourceId: null, effect: ok ? 'supports' : null,
      provenance: { type: 'experiment', ref: t.id },
    });
    const failureOutput = t.status !== 'passed' ? t.result?.attempts.find((a) => !a.passed)?.outputTail ?? '' : suiteFailure;
    return { ok, failureOutput, summary };
  }

  /**
   * Re-runs validation for an existing candidate patch in a fresh sandbox.
   * Does not change the investigation's verdict; results are appended to the
   * ledger and stored on the patch.
   */
  async revalidate(patchId: string): Promise<void> {
    const inv = this.inv;
    const patch = this.store.getPatch(patchId);
    if (!patch || patch.investigationId !== this.id) throw new Error('Patch not found for this investigation');
    this.quiet = true;
    try {
      const sample = inv.source === 'demo' && inv.scenarioId ? inv.scenarioId : inv.change?.origin.kind === 'sample' ? inv.change.origin.scenarioId : null;
      const location = sample ? demoRepoPath(sample) : `https://github.com/${inv.repository}`;
      const cacheKey = sample ? `demo:${sample}` : `gh:${inv.repository}`;
      this.facts = extractFacts(this.store.getLog(this.id) ?? '', inv.framework);
      this.intake = { source: { location, cacheKey }, log: '', diff: null, repoDir: null };
      this.pool = new WorkspacePool(this.intake.source, this.workRoot, this.facts.framework);
      await this.validatePatch(patch, inv.classification ?? 'unknown');
    } catch (err) {
      this.store.updatePatch(patchId, { status: 'failed', validation: { ...(patch.validation ?? {}), summary: `Re-validation could not run: ${(err as Error).message}` } });
    } finally {
      if (existsSync(this.workRoot)) rmSync(this.workRoot, { recursive: true, force: true });
    }
  }

  // ------------------------------------------------------------ 7. finalize
  private finalize(v: VerdictOutput) {
    const inv = this.inv;
    const experiments = this.store.listExperiments(this.id);
    const patches = this.store.listPatches(this.id);
    const sources = this.store.listSources(this.id);
    const d = this.intake.diff;
    const conf = assessConfidence({ classification: v.classification, experiments, patches, dependencyChanged: (d?.dependencyChanges.length ?? 0) > 0, docsOnlyChange: d?.onlyDocs ?? false, corroboratingSources: sources.filter((s) => s.official).length });
    let verdict = reconcileVerdict(v.verdict, conf).verdict;
    let note = `Evidence rubric: ${conf.label}.`;
    const validated = patches.filter((p) => p.status === 'validated');
    const fixProves = v.classification === 'code_regression' || v.classification === 'dependency_regression';
    if (verdict === 'probable' && conf.label === 'strong' && v.classification !== 'unknown' && (!fixProves || validated.some((p) => p.strategy !== 'quarantine'))) {
      verdict = 'confirmed';
      note = fixProves
        ? `Upgraded to confirmed: "${validated.find((p) => p.strategy !== 'quarantine')!.title}" fixed the failing selection without regressions, and the discriminating experiments agree.`
        : `Upgraded to confirmed: the evidence rubric is strong — ${conf.basis.filter((b) => /Repeated|Parent|documentation/.test(b)).join(' ')}`;
    } else if (v.verdict === 'confirmed' && verdict !== 'confirmed') {
      note = `Capped at ${verdict}: "confirmed" requires a strong evidence rubric (currently ${conf.label}).`;
    }
    const remediation = validated[0]?.strategy ?? (v.classification === 'infrastructure' ? 'retry' : v.remediation_type);
    const executed = experiments.filter((e) => e.backend === 'docker' && e.result);
    const assumptions = [
      executed.length
        ? `Experiments ran in ${String(executed[0].environment?.image ?? 'a container')} with networking disabled, not on the original CI runner; environment-specific causes (runner image, caches, secrets, network) are not reproduced.`
        : null,
    ].filter(Boolean) as string[];
    for (const a of assumptions) {
      this.evidence({ kind: 'assumption', title: 'Sandbox approximates CI', detail: a, hypothesisKey: null, experimentId: null, sourceId: null, effect: null, provenance: { type: 'policy', ref: 'runner' } });
    }
    const repeat = experiments.find((e) => e.kind === 'repeat' && e.result?.failureRate && e.result.failures > 0 && e.result.passes > 0);
    const limitations = [...new Set([
      ...this.limitations,
      ...(repeat ? [`Flake rate measured over ${repeat.result!.attempts.length} runs (${pct(repeat.result!.failureRate!.rate)}, 95% CI ${pct(repeat.result!.failureRate!.low)}–${pct(repeat.result!.failureRate!.high)}); more runs are needed for a precise rate.`] : []),
      ...(remediationSummary(patches) ? [remediationSummary(patches)!] : []),
    ])];
    this.update({
      verdict,
      confidence: conf,
      remediationType: remediation,
      limitations,
      status: verdict === 'inconclusive' ? 'inconclusive' : 'completed',
      stage: 'Complete',
    });
    this.pushVerdict('Remediation tested', verdict, note, conf.label);
    if (config.agentLoop.enabled) {
      const lr = this.loopResult;
      const sandboxRan = experiments.some((e) => e.backend === 'docker' && e.result);
      const allPatches = this.store.listPatches(this.id);
      const agent: NonNullable<Investigation['agent']> = {
        iterations: lr?.iterations ?? 0,
        modelCalls: lr?.modelCalls ?? 0,
        executed: lr?.executed ?? 0,
        rejected: lr?.rejected ?? 0,
        promptTokens: lr?.promptTokens ?? 0,
        completionTokens: lr?.completionTokens ?? 0,
        elapsedMs: lr?.elapsedMs ?? 0,
        stopReason: lr?.stopReason ?? 'not_run',
        stopDetail: this.loopStopDetail || 'The loop did not run (the investigation stopped earlier).',
        patchRetries: this.patchRetries,
        diagnosis: diagnosisOutcome(verdict, { sandboxRan, stopReason: lr?.stopReason ?? null }),
        fix: fixOutcome(allPatches),
      };
      this.update({ agent });
      this.evidence({
        kind: 'inference',
        title: `Outcome: diagnosis ${agent.diagnosis} · fix ${agent.fix}`,
        detail: `Diagnosis is about the cause (verdict: ${verdict}). Fix is about candidate patches and is independent: ${agent.fix === 'VERIFIED' ? 'at least one candidate passed fresh-sandbox validation' : agent.fix === 'REJECTED' ? 'every candidate failed validation' : 'no candidate passed validation'}.\nAgent loop: ${agent.iterations} iteration(s), ${agent.executed} experiment(s) executed, ${agent.rejected} proposal(s) rejected, ${agent.patchRetries} patch retry. Stopped: ${agent.stopDetail}`,
        hypothesisKey: null, experimentId: null, sourceId: null, effect: null,
        provenance: { type: 'policy', ref: 'outcome rules' },
      });
    }
    this.evidence({
      kind: 'inference',
      title: `Final verdict: ${verdict} — ${v.classification.replace(/_/g, ' ')} (${conf.label} evidence)`,
      detail: `${note}\n\nBasis:\n${conf.basis.map((b) => `• ${b}`).join('\n')}\n\nRecommended action: ${inv.recommendedAction ?? v.recommended_action}`,
      hypothesisKey: v.primary_hypothesis, experimentId: null, sourceId: null, effect: null,
      provenance: { type: 'policy', ref: 'confidence rubric' },
    });
  }
}

export function freshInvestigation(partial: Partial<Investigation> & Pick<Investigation, 'source' | 'repository' | 'commitSha'>): Investigation {
  const now = nowIso();
  return {
    id: newId('inv'),
    createdAt: now,
    updatedAt: now,
    status: 'queued',
    stage: 'Queued',
    scenarioId: null,
    mode: 'heuristic',
    repoUrl: null,
    parentSha: null,
    branch: null,
    workflow: null,
    job: null,
    runId: null,
    runUrl: null,
    prNumber: null,
    prUrl: null,
    commitMessage: null,
    commitAuthor: null,
    framework: 'unknown',
    failureSignature: null,
    classification: null,
    summary: null,
    verdict: null,
    confidence: null,
    primaryHypothesis: null,
    recommendedAction: null,
    remediationType: null,
    limitations: [],
    error: null,
    logStats: null,
    modelsUsed: {},
    verdictHistory: [],
    options: { repeat: config.runner.repeatDefault, requestedMode: 'auto' },
    artifacts: [],
    ...partial,
  };
}
