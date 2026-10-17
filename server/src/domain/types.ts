export const CLASSIFICATIONS = [
  'code_regression',
  'flaky_test',
  'infrastructure',
  'dependency_regression',
  'external_outage',
  'unknown',
] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export const VERDICTS = ['confirmed', 'probable', 'inconclusive'] as const;
export type Verdict = (typeof VERDICTS)[number];

export type InvestigationStatus = 'queued' | 'running' | 'completed' | 'inconclusive' | 'failed';
export type InvestigationSource = 'demo' | 'github';
/** How model-dependent steps were produced. */
export type ReasoningMode = 'live' | 'replay' | 'heuristic';
/** Frameworks Alibi can parse. Only jest and maven have sandbox experiment support. */
export type Framework = 'jest' | 'maven' | 'mocha' | 'unknown';

export type ConfidenceLabel = 'strong' | 'moderate' | 'weak' | 'none';

export interface ConfidenceAssessment {
  label: ConfidenceLabel;
  /** Each line is a concrete, checkable reason (e.g. "Parent commit passed 3/3 runs"). */
  basis: string[];
}

export interface Investigation {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: InvestigationStatus;
  stage: string;
  source: InvestigationSource;
  scenarioId: string | null;
  mode: ReasoningMode;
  repository: string;
  repoUrl: string | null;
  commitSha: string;
  parentSha: string | null;
  branch: string | null;
  workflow: string | null;
  job: string | null;
  runId: string | null;
  runUrl: string | null;
  prNumber: number | null;
  prUrl: string | null;
  commitMessage: string | null;
  commitAuthor: string | null;
  framework: Framework;
  failureSignature: string | null;
  classification: Classification | null;
  summary: string | null;
  verdict: Verdict | null;
  confidence: ConfidenceAssessment | null;
  primaryHypothesis: string | null;
  recommendedAction: string | null;
  remediationType: RemediationType | null;
  limitations: string[];
  error: string | null;
  logStats: LogStats | null;
  modelsUsed: Record<string, string>;
  /** How the verdict evolved as evidence arrived. */
  verdictHistory: Array<{ at: string; stage: string; verdict: Verdict | null; confidence: ConfidenceLabel; note: string }>;
  /** Run-time options chosen when the investigation was started. */
  options: { repeat: number; requestedMode: 'auto' | 'live' | 'replay' | 'heuristic' };
  /** Present only when the bounded agent loop ran (ALIBI_LOOP=1). */
  agent?: {
    iterations: number;
    modelCalls: number;
    executed: number;
    rejected: number;
    promptTokens: number;
    completionTokens: number;
    elapsedMs: number;
    stopReason: string;
    stopDetail: string;
    patchRetries: number;
    /** About the cause: derived from the verdict. */
    diagnosis: 'CONFIRMED' | 'PROBABLE' | 'INCONCLUSIVE' | 'BLOCKED';
    /** About candidate fixes, independent of the diagnosis: VERIFIED only after fresh-sandbox validation passed. */
    fix: 'VERIFIED' | 'REJECTED' | 'NONE';
  };
  /** Artifacts listed by the CI provider (names and sizes; not downloaded). */
  artifacts: Array<{ name: string; sizeInBytes: number; expired: boolean }>;
}

export interface LogStats {
  totalLines: number;
  totalChars: number;
  sentChars: number;
  excerptCount: number;
  redactions: number;
}

export type HypothesisStatus = 'open' | 'supported' | 'refuted' | 'inconclusive';
export type Origin = 'model' | 'replay' | 'heuristic' | 'deterministic';

export interface EvidenceRef {
  text: string;
  /** 1-based line in the CI log, if the claim cites one. */
  logLine?: number | null;
  /** True when the cited text was found in the log at (or near) that line. */
  verified?: boolean;
}

export interface Hypothesis {
  id: string;
  investigationId: string;
  key: string;
  cause: string;
  category: Classification;
  origin: Origin;
  supporting: EvidenceRef[];
  contradicting: EvidenceRef[];
  prior: 'high' | 'medium' | 'low';
  status: HypothesisStatus;
  assessment: string | null;
  nextExperiment: string | null;
  rank: number;
}

export type ExperimentKind =
  | 'reproduce'
  | 'repeat'
  | 'compare_parent'
  | 'external_search'
  | 'validate_patch'
  | 'regression_suite';

export type ExperimentStatus = 'queued' | 'running' | 'passed' | 'failed' | 'error' | 'skipped';

export interface TestCounts {
  total: number;
  passed: number;
  failed: number;
  failedNames: string[];
}

export interface Attempt {
  index: number;
  exitCode: number | null;
  passed: boolean;
  timedOut: boolean;
  durationMs: number;
  seed?: number;
  tests: TestCounts | null;
  outputTail: string;
}

export interface ExperimentResult {
  attempts: Attempt[];
  passes: number;
  failures: number;
  /** Empirical failure rate with a Wilson 95% interval, when attempts > 1. */
  failureRate?: { rate: number; low: number; high: number; n: number };
  notes?: string[];
}

export interface Experiment {
  id: string;
  investigationId: string;
  hypothesisKey: string | null;
  kind: ExperimentKind;
  title: string;
  reason: string;
  status: ExperimentStatus;
  backend: 'docker' | 'tavily' | 'none';
  command: string[] | null;
  environment: Record<string, unknown> | null;
  commitSha: string | null;
  testSelection: string | null;
  plannedAttempts: number;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  result: ExperimentResult | null;
  observation: string | null;
  effect: string | null;
  patchId: string | null;
}

export type EvidenceKind =
  | 'observed_fact'
  | 'model_hypothesis'
  | 'experiment_result'
  | 'external_source'
  | 'inference'
  | 'assumption';

export interface Provenance {
  type: 'log' | 'git' | 'github_api' | 'experiment' | 'web' | 'model' | 'fixture' | 'policy';
  ref?: string;
  lines?: [number, number];
  url?: string;
}

export interface EvidenceRecord {
  id: string;
  investigationId: string;
  seq: number;
  kind: EvidenceKind;
  title: string;
  detail: string;
  hypothesisKey: string | null;
  experimentId: string | null;
  sourceId: string | null;
  effect: 'supports' | 'contradicts' | 'neutral' | null;
  provenance: Provenance;
  createdAt: string;
}

export interface ExternalSource {
  id: string;
  investigationId: string;
  hypothesisKey: string | null;
  query: string;
  title: string;
  url: string;
  domain: string;
  excerpt: string;
  score: number | null;
  publishedDate: string | null;
  official: boolean;
  relevance: string;
  retrievedAt: string;
}

export type RemediationType = 'retry' | 'quarantine' | 'dependency_pin' | 'code_patch' | 'none';
export type PatchStatus = 'proposed' | 'validating' | 'validated' | 'failed' | 'rejected';

export interface Patch {
  id: string;
  investigationId: string;
  origin: Origin;
  strategy: RemediationType;
  title: string;
  rationale: string;
  diff: string;
  files: string[];
  status: PatchStatus;
  validation: { targetedExperimentId?: string; suiteExperimentId?: string; summary?: string } | null;
  prUrl: string | null;
  prBranch: string | null;
  createdAt: string;
}

export interface ModelCall {
  id: string;
  investigationId: string | null;
  step: string;
  role: string;
  model: string;
  status: 'ok' | 'error' | 'invalid' | 'replay';
  startedAt: string;
  durationMs: number;
  inputChars: number;
  promptTokens: number | null;
  completionTokens: number | null;
  attempts: number;
  error: string | null;
}
