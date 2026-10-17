/**
 * Bounded, model-driven investigation loop (enabled with ALIBI_LOOP=1).
 *
 * The model proposes one action per iteration; this module decides whether it
 * may run. Nothing the model writes is executed: approved actions are mapped
 * onto the existing fixed command templates by the caller. Every budget and
 * stop condition is enforced here, in `runAgentLoop`, and nowhere else.
 *
 * This module is pure (no Docker, model, or database access) so the policy and
 * stop rules are unit-tested directly.
 */
import type { LoopObservation } from '../llm/prompts.js';
import type { NextActionOutput } from '../llm/schemas.js';
import type { Patch, Verdict } from '../domain/types.js';
import type { TestSelection } from '../runner/frameworks.js';

export type StopReason =
  | 'model_concluded'
  | 'max_iterations'
  | 'model_call_budget'
  | 'token_budget'
  | 'time_limit'
  | 'run_budget'
  | 'no_allowed_action'
  | 'stalled'
  | 'policy_blocked'
  | 'model_error'
  | 'model_unavailable';

export const STOP_REASON_TEXT: Record<StopReason, string> = {
  model_concluded: 'The model concluded that the evidence is sufficient.',
  max_iterations: 'Reached the maximum number of loop iterations.',
  model_call_budget: 'Reached the per-investigation model-call budget for the loop.',
  token_budget: 'Reached the loop token budget.',
  time_limit: 'Reached the loop time limit.',
  run_budget: 'No sandbox test runs left in the loop budget.',
  no_allowed_action: 'No allowed experiment remains.',
  stalled: 'Two consecutive iterations changed no hypothesis.',
  policy_blocked: 'Two consecutive proposals were rejected by policy.',
  model_error: 'The model call failed or returned invalid output.',
  model_unavailable: 'No model output is available in this mode (heuristic, or no recorded replay).',
};

export interface LoopLimits {
  maxIterations: number;
  maxModelCalls: number;
  maxTokens: number;
  maxMs: number;
  maxRuns: number;
  maxRunsPerAction: number;
  maxSearches: number;
}

export const DEFAULT_LIMITS: LoopLimits = {
  maxIterations: 4,
  maxModelCalls: 4,
  maxTokens: 40_000,
  maxMs: 8 * 60_000,
  maxRuns: 30,
  maxRunsPerAction: 10,
  maxSearches: 2,
};

export interface SelectionOption {
  id: string;
  label: string;
  selection: TestSelection;
}

export interface LoopPolicyContext {
  selections: SelectionOption[];
  hasParent: boolean;
  searchEnabled: boolean;
}

export type ApprovedAction =
  | { tool: 'reproduce' | 'run_test'; commit: 'failing' | 'parent'; selectionId: string; runs: 1 }
  | { tool: 'repeat'; commit: 'failing' | 'parent'; selectionId: string; runs: number }
  | { tool: 'search'; query: string };

export interface LoopState {
  runsUsed: number;
  searchesUsed: number;
  /** Keys of actions already executed (baseline + loop), for duplicate rejection. */
  seen: Set<string>;
}

export function actionKey(a: ApprovedAction): string {
  if (a.tool === 'search') return `search|${a.query.toLowerCase().replace(/\s+/g, ' ').trim()}`;
  // reproduce and run_test are the same single run; repeat differs by run count.
  const t = a.tool === 'repeat' ? `repeat:${a.runs}` : 'single';
  return `${t}|${a.commit}|${a.selectionId}`;
}

const FORBIDDEN_ARG = /^(command|cmd|shell|script|exec|args|argv|path|file|env|image|network|sha)$/i;

/** The only argument names each allowlisted tool accepts. */
const ALLOWED_ARGS: Record<string, string[]> = {
  reproduce: ['commit', 'test'],
  run_test: ['commit', 'test'],
  repeat: ['commit', 'test', 'runs'],
  search: ['query'],
};

/** Deterministic policy. Returns the approved action or the reason it was rejected. */
export function validateAction(
  proposal: NonNullable<NextActionOutput['action']>,
  ctx: LoopPolicyContext,
  state: LoopState,
  limits: LoopLimits,
): { ok: true; action: ApprovedAction; key: string } | { ok: false; reason: string } {
  const tool = String(proposal.tool ?? '').trim();
  const args = (proposal.args ?? {}) as Record<string, unknown>;
  const forbidden = Object.keys(args).filter((k) => FORBIDDEN_ARG.test(k));
  if (forbidden.length) return { ok: false, reason: `Arguments not accepted (commands, paths, and environment are never taken from the model): ${forbidden.join(', ')}` };
  // Unknown fields are rejected rather than silently dropped, so a request for something the
  // policy cannot grant (environment, working directory, timeouts...) never runs in a weaker form.
  const allowed = ALLOWED_ARGS[tool];
  const unknown = allowed ? Object.keys(args).filter((k) => !allowed.includes(k)) : [];
  if (unknown.length) return { ok: false, reason: `Unknown argument(s) for ${tool}: ${unknown.map((k) => k.slice(0, 30)).join(', ')} (allowed: ${allowed!.join(', ')}).` };

  if (tool === 'search') {
    if (!ctx.searchEnabled) return { ok: false, reason: 'Search is not available (Tavily is not configured).' };
    if (state.searchesUsed >= limits.maxSearches) return { ok: false, reason: `Search budget exhausted (${limits.maxSearches}).` };
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (query.length < 8 || query.length > 200 || /[\r\n]/.test(query)) return { ok: false, reason: 'Search query must be a single line of 8–200 characters.' };
    const action: ApprovedAction = { tool: 'search', query };
    const key = actionKey(action);
    if (state.seen.has(key)) return { ok: false, reason: 'Duplicate search query.' };
    return { ok: true, action, key };
  }

  if (tool !== 'reproduce' && tool !== 'repeat' && tool !== 'run_test') {
    return { ok: false, reason: `Tool "${tool.slice(0, 40)}" is not on the allowlist (reproduce, repeat, run_test, search).` };
  }
  const commit = args.commit === undefined ? 'failing' : args.commit;
  if (commit !== 'failing' && commit !== 'parent') return { ok: false, reason: 'commit must be "failing" or "parent".' };
  if (commit === 'parent' && !ctx.hasParent) return { ok: false, reason: 'The parent commit is unknown for this investigation.' };
  const selectionId = String(args.test ?? '');
  if (!ctx.selections.some((s) => s.id === selectionId)) {
    return { ok: false, reason: `Unknown test selection "${selectionId.slice(0, 40)}"; use one of ${ctx.selections.map((s) => s.id).join(', ')}.` };
  }
  let runs = 1;
  if (tool === 'repeat') {
    runs = typeof args.runs === 'number' && Number.isInteger(args.runs) ? args.runs : NaN;
    if (!(runs >= 2 && runs <= limits.maxRunsPerAction)) return { ok: false, reason: `repeat.runs must be an integer from 2 to ${limits.maxRunsPerAction}.` };
  }
  if (state.runsUsed + runs > limits.maxRuns) return { ok: false, reason: `Run budget exceeded (${state.runsUsed}/${limits.maxRuns} used).` };
  const action: ApprovedAction = tool === 'repeat' ? { tool, commit, selectionId, runs } : { tool, commit, selectionId, runs: 1 };
  const key = actionKey(action);
  if (state.seen.has(key)) return { ok: false, reason: 'Duplicate experiment: this exact action has already run.' };
  return { ok: true, action, key };
}

// ---------------------------------------------------------------------------
// Controller

export interface DecideInput {
  iteration: number;
  observations: LoopObservation[];
  remaining: { iterations: number; runs: number; searches: number };
}

export interface DecideResult {
  data: NextActionOutput;
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
}

export type LoopEvent =
  | { type: 'decision'; iteration: number; model: string; data: NextActionOutput }
  | { type: 'rejected'; iteration: number; reason: string; proposal: NonNullable<NextActionOutput['action']> }
  | { type: 'executed'; iteration: number; action: ApprovedAction; observation: LoopObservation; experimentId: string | null }
  | { type: 'stopped'; reason: StopReason; detail: string };

export interface LoopDeps {
  /** One model decision. Returns null when no model output exists in this mode. Throws on model failure. */
  decide(input: DecideInput): Promise<DecideResult | null>;
  /** Executes an approved action in the sandbox (or search) and returns the actual observation. */
  execute(action: ApprovedAction, iteration: number): Promise<{ observation: LoopObservation; experimentId: string | null }>;
  record(event: LoopEvent): void;
  now(): number;
}

export interface LoopResult {
  iterations: number;
  modelCalls: number;
  promptTokens: number;
  completionTokens: number;
  executed: number;
  rejected: number;
  elapsedMs: number;
  stopReason: StopReason;
}

/**
 * Runs the bounded loop. All limits are checked here before every model call
 * and before every execution; the caller never needs to re-check them.
 */
export async function runAgentLoop(
  ctx: LoopPolicyContext,
  limits: LoopLimits,
  deps: LoopDeps,
  baseline: LoopObservation[],
  state: LoopState,
): Promise<LoopResult> {
  const started = deps.now();
  const observations = [...baseline];
  const r: Omit<LoopResult, 'stopReason' | 'elapsedMs'> = { iterations: 0, modelCalls: 0, promptTokens: 0, completionTokens: 0, executed: 0, rejected: 0 };
  let consecutiveRejections = 0;
  let consecutiveNoChange = 0;

  const stop = (reason: StopReason, detail = STOP_REASON_TEXT[reason]): LoopResult => {
    deps.record({ type: 'stopped', reason, detail });
    return { ...r, stopReason: reason, elapsedMs: deps.now() - started };
  };
  const remaining = () => ({
    iterations: limits.maxIterations - r.iterations,
    runs: limits.maxRuns - state.runsUsed,
    searches: ctx.searchEnabled ? limits.maxSearches - state.searchesUsed : 0,
  });

  for (;;) {
    // ---- central budget checks before any model call
    if (r.iterations >= limits.maxIterations) return stop('max_iterations');
    if (r.modelCalls >= limits.maxModelCalls) return stop('model_call_budget');
    if (r.promptTokens + r.completionTokens >= limits.maxTokens) return stop('token_budget');
    if (deps.now() - started >= limits.maxMs) return stop('time_limit');
    const rem = remaining();
    if (rem.runs <= 0 && rem.searches <= 0) return stop('run_budget');

    r.iterations++;
    let decided: DecideResult | null;
    try {
      r.modelCalls++;
      decided = await deps.decide({ iteration: r.iterations, observations, remaining: rem });
    } catch (err) {
      return stop('model_error', `${STOP_REASON_TEXT.model_error} ${(err as Error).message.slice(0, 200)}`);
    }
    if (!decided) {
      r.modelCalls--;
      return stop('model_unavailable');
    }
    r.promptTokens += decided.promptTokens ?? 0;
    r.completionTokens += decided.completionTokens ?? 0;
    deps.record({ type: 'decision', iteration: r.iterations, model: decided.model, data: decided.data });

    const changed = decided.data.hypothesis_updates.some((u) => u.status !== 'unchanged');
    consecutiveNoChange = changed ? 0 : consecutiveNoChange + 1;

    if (decided.data.decision === 'conclude' || !decided.data.action) return stop('model_concluded');

    const verdict = validateAction(decided.data.action, ctx, state, limits);
    if (!verdict.ok) {
      r.rejected++;
      consecutiveRejections++;
      deps.record({ type: 'rejected', iteration: r.iterations, reason: verdict.reason, proposal: decided.data.action });
      if (consecutiveRejections >= 2) return stop('policy_blocked');
      continue;
    }
    consecutiveRejections = 0;

    // ---- central checks again immediately before execution
    if (deps.now() - started >= limits.maxMs) return stop('time_limit');
    if (r.promptTokens + r.completionTokens > limits.maxTokens) return stop('token_budget');

    state.seen.add(verdict.key);
    if (verdict.action.tool === 'search') state.searchesUsed++;
    else state.runsUsed += verdict.action.runs;
    const { observation, experimentId } = await deps.execute(verdict.action, r.iterations);
    r.executed++;
    observations.push(observation);
    deps.record({ type: 'executed', iteration: r.iterations, action: verdict.action, observation, experimentId });

    if (consecutiveNoChange >= 2) return stop('stalled');
  }
}

// ---------------------------------------------------------------------------
// Outcomes: diagnosis (about the cause) and fix (about candidate patches) are
// separate so a confirmed cause can never be read as a validated fix.

export type DiagnosisOutcome = 'CONFIRMED' | 'PROBABLE' | 'INCONCLUSIVE' | 'BLOCKED';
export type FixOutcome = 'VERIFIED' | 'REJECTED' | 'NONE';

export function diagnosisOutcome(verdict: Verdict | null, opts: { sandboxRan: boolean; stopReason: StopReason | null }): DiagnosisOutcome {
  // No sandbox run means no experimental evidence could be obtained: whatever the verdict
  // text says, the diagnosis was blocked, not established.
  if (!opts.sandboxRan) return 'BLOCKED';
  if (verdict === 'confirmed') return 'CONFIRMED';
  if (verdict === 'probable') return 'PROBABLE';
  // Inconclusive because every proposed experiment was refused, not because results were ambiguous.
  if (opts.stopReason === 'policy_blocked') return 'BLOCKED';
  return 'INCONCLUSIVE';
}

/** VERIFIED only when at least one candidate passed fresh-sandbox validation. */
export function fixOutcome(patches: Pick<Patch, 'status'>[]): FixOutcome {
  if (!patches.length) return 'NONE';
  if (patches.some((p) => p.status === 'validated')) return 'VERIFIED';
  return patches.every((p) => p.status === 'failed' || p.status === 'rejected') ? 'REJECTED' : 'NONE';
}
