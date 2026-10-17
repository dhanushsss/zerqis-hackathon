import type { Bundle, EvidenceRecord, Experiment, Hypothesis, Patch } from '../../api';

export type StageState = 'pending' | 'running' | 'done' | 'skipped' | 'failed' | 'inconclusive';
export interface Stage {
  key: 'evidence' | 'hypotheses' | 'experiments' | 'verdict' | 'remediation';
  name: string;
  short: string;
  state: StageState;
  meta: string;
}

const isRunning = (b: Bundle) => b.investigation.status === 'running' || b.investigation.status === 'queued';
export const isTestExp = (e: Experiment) => e.backend === 'docker';
export const isDiagnostic = (e: Experiment) => e.kind !== 'validate_patch' && e.kind !== 'regression_suite';

/** Stage states derived only from persisted investigation data. */
export function stages(b: Bundle): Stage[] {
  const inv = b.investigation;
  const running = isRunning(b);
  const stage = inv.stage;
  const diag = b.experiments.filter(isDiagnostic);
  const ran = diag.filter((e) => e.result && isTestExp(e));
  const runs = ran.reduce((n, e) => n + (e.result?.attempts.length ?? 0), 0);
  const expActive = diag.some((e) => e.status === 'running' || e.status === 'queued');
  const validated = b.patches.filter((p) => p.status === 'validated').length;
  const patchActive = b.patches.some((p) => p.status === 'validating' || p.status === 'proposed') && running;

  const out: Stage[] = [
    {
      key: 'evidence',
      name: 'Evidence', short: 'Evidence',
      state: inv.logStats ? 'done' : running ? 'running' : 'pending',
      meta: inv.logStats ? `${inv.logStats.totalLines.toLocaleString()} log lines · ${inv.logStats.excerptCount} ${inv.logStats.excerptCount === 1 ? 'excerpt' : 'excerpts'}` : 'Reading CI log',
    },
    {
      key: 'hypotheses',
      name: 'Hypotheses', short: 'Ideas',
      state: b.hypotheses.length ? 'done' : running && /hypotheses/i.test(stage) ? 'running' : 'pending',
      meta: b.hypotheses.length ? `${b.hypotheses.length} competing` : 'Not formed yet',
    },
    {
      key: 'experiments',
      name: 'Experiments', short: 'Tests',
      state: expActive && running ? 'running' : ran.length ? 'done' : diag.length && diag.every((e) => e.status === 'skipped' || e.status === 'error') ? 'skipped' : running && /experiment|Planning|Searching/i.test(stage) ? 'running' : 'pending',
      meta: diag.length ? `${ran.length} executed · ${runs} ${runs === 1 ? 'run' : 'runs'}${diag.some((e) => e.status === 'skipped') ? ` · ${diag.filter((e) => e.status === 'skipped').length} skipped` : ''}` : 'Not planned yet',
    },
    {
      key: 'verdict',
      name: 'Verdict', short: 'Verdict',
      state: inv.verdict ? (running && /Weighing/.test(stage) ? 'running' : inv.verdict === 'inconclusive' && !running ? 'inconclusive' : 'done') : running && /Weighing/.test(stage) ? 'running' : 'pending',
      meta: inv.verdict ? `${inv.verdict}${inv.confidence ? ` · ${inv.confidence.label} evidence` : ''}` : 'Awaiting experiments',
    },
    {
      key: 'remediation',
      name: 'Remediation', short: 'Fix',
      state: patchActive || (running && /remediation|Validating/i.test(stage)) ? 'running' : b.patches.length ? 'done' : !running && inv.verdict ? 'skipped' : 'pending',
      meta: b.patches.length ? `${validated}/${b.patches.length} ${b.patches.length === 1 ? 'fix' : 'fixes'} validated` : inv.remediationType === 'retry' ? 'Retry advised' : !running && inv.verdict ? 'No fix justified' : 'After the verdict',
    },
  ];
  // A change verification that ended without a diagnosis (blocked, or no failing test) skips the later steps.
  const c = inv.change;
  if (c?.outcome && !inv.verdict && !running) {
    const why = c.outcome === 'blocked' ? 'Blocked: required runs could not happen' : 'Not needed: no test failed';
    for (const k of ['hypotheses', 'verdict', 'remediation']) {
      const i = out.findIndex((s) => s.key === k);
      out[i] = { ...out[i], state: 'skipped', meta: why };
    }
    out[0] = { ...out[0], state: 'done', meta: c.examined.length ? `Full suite at ${c.examined.length} ${c.examined.length === 1 ? 'revision' : 'revisions'}` : 'Revisions checked' };
  }
  if (inv.status === 'failed') {
    const i = out.findIndex((s) => s.state !== 'done');
    if (i >= 0) {
      out[i] = { ...out[i], state: 'failed', meta: 'Stopped here' };
      for (let j = i + 1; j < out.length; j++) out[j] = { ...out[j], state: 'pending', meta: 'Not reached' };
    }
  }
  return out;
}

export function effectsFor(b: Bundle, key: string): EvidenceRecord[] {
  return b.evidence.filter((e) => e.kind === 'inference' && e.hypothesisKey === key && e.effect && e.effect !== 'neutral' && e.experimentId);
}

const PRIORITY: Record<string, number> = { compare_parent: 0, repeat: 1, reproduce: 2, external_search: 3 };

/** The most discriminating experiment that supports the primary hypothesis. */
export function strongestSupport(b: Bundle): { exp: Experiment; why: string } | null {
  const key = b.investigation.primaryHypothesis;
  if (!key) return null;
  const supports = effectsFor(b, key)
    .filter((e) => e.effect === 'supports')
    .map((e) => ({ exp: b.experiments.find((x) => x.id === e.experimentId)!, why: e.detail }))
    .filter((x) => x.exp)
    .sort((a, b2) => (PRIORITY[a.exp.kind] ?? 9) - (PRIORITY[b2.exp.kind] ?? 9));
  return supports[0] ?? null;
}

/** Evidence against the primary hypothesis, and alternatives the experiments ruled out. */
export function counterEvidence(b: Bundle): { against: Array<{ exp?: Experiment; why: string }>; ruledOut: Hypothesis[] } {
  const key = b.investigation.primaryHypothesis;
  const against = key
    ? effectsFor(b, key)
        .filter((e) => e.effect === 'contradicts')
        .map((e) => ({ exp: b.experiments.find((x) => x.id === e.experimentId), why: e.detail }))
    : [];
  const ruledOut = b.hypotheses.filter((h) => h.key !== key && h.status === 'refuted');
  return { against, ruledOut };
}

/** Experiments that finished between two verdict-history entries. */
export function observationsBetween(b: Bundle, from: string | null, to: string): Experiment[] {
  const t1 = from ? Date.parse(from) : 0;
  const t2 = Date.parse(to);
  return b.experiments.filter((e) => e.finishedAt && e.status !== 'skipped' && Date.parse(e.finishedAt) > t1 && Date.parse(e.finishedAt) <= t2);
}

export type Phase = 'evidence' | 'hypotheses' | 'experiments' | 'assessment' | 'remediation' | 'final';

export function phaseOf(e: EvidenceRecord, b: Bundle): Phase {
  if (e.kind === 'model_hypothesis') return 'hypotheses';
  // Agent-loop decisions, policy rejections, and the loop's stop record belong with the experiments.
  if (/^Agent (step \d+|loop stopped)/.test(e.title)) return 'experiments';
  if (/^Outcome: diagnosis/.test(e.title)) return 'final';
  const exp = e.experimentId ? b.experiments.find((x) => x.id === e.experimentId) : null;
  if ((exp && !isDiagnostic(exp)) || /^Candidate/.test(e.title)) return 'remediation';
  if (exp || e.kind === 'external_source' || /^No experiments executed/.test(e.title)) return 'experiments';
  if (/^Final verdict/.test(e.title) || e.kind === 'assumption' || /^Investigation stopped/.test(e.title)) return 'final';
  if (e.kind === 'inference') return 'assessment';
  return 'evidence';
}

export const PHASE_LABEL: Record<Phase, string> = {
  evidence: 'Failure evidence',
  hypotheses: 'Hypotheses',
  experiments: 'Experiments',
  assessment: 'Assessment',
  remediation: 'Remediation',
  final: 'Conclusion',
};

export function patchRisks(p: Patch): string[] {
  const risks: string[] = [];
  if (p.status === 'failed') risks.push('Validation failed. Do not apply this patch.');
  if (p.status === 'proposed') risks.push('Not validated: no test has run against this patch yet.');
  if (p.strategy === 'quarantine') risks.push('The test is skipped, not fixed. The nondeterminism remains, and coverage for this behaviour is lost until it is re-enabled.');
  if (p.strategy === 'dependency_pin') risks.push('Holds the dependency at the previous version; the upgrade still needs a code migration.');
  if (p.strategy === 'code_patch' && p.origin === 'deterministic') risks.push('Reverts every change in these files, including unrelated refactors from the same commit.');
  if (p.origin === 'model' || p.origin === 'replay') risks.push('Written by a model. Review the logic, not only the test result.');
  if (p.status === 'validated') risks.push("Validated against this repository's existing tests in the sandbox, not on the original CI runner.");
  return risks;
}
