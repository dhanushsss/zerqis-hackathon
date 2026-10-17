/**
 * Evidence Path view model: a pure, deterministic projection of an investigation
 * bundle into columns, nodes, and edges. It never computes verdicts or support;
 * every node is an existing record and every edge is a relationship the backend
 * already recorded:
 *
 *   cites       Hypothesis.supporting[].logLine (only quotes verified in the log)
 *   targets     Experiment.hypothesisKey (set by the planner)
 *   supports /  ledger `inference` records with experimentId + hypothesisKey +
 *   contradicts effect (written by the deterministic effect rules)
 *   primary     Investigation.primaryHypothesis → the verdict
 *   (validation runs are listed in a fix's details via Experiment.patchId /
 *   Patch.validation, not drawn as edges, because they are not path nodes)
 *
 * No edge is drawn between the diagnosis and a fix: that link is not recorded.
 */
import type { Bundle, EvidenceRecord, Experiment, Hypothesis, Patch } from '../../api';
import { isDiagnostic } from './derive';

export type PathColumn = 'failure' | 'hypotheses' | 'experiments' | 'diagnosis' | 'remediation';
export type PathKind = 'log' | 'observed_fact' | 'hypothesis' | 'experiment' | 'verdict' | 'patch';

/** Display state. Each maps 1:1 from an existing status field; nothing is inferred. */
export type PathState =
  | 'observed'
  | 'supported'
  | 'contradicted'
  | 'unresolved'
  | 'untested'
  | 'tests_passed'
  | 'tests_failed'
  | 'intermittent'
  | 'completed'
  | 'skipped'
  | 'error'
  | 'running'
  | 'queued'
  | 'confirmed'
  | 'probable'
  | 'inconclusive'
  | 'no_verdict'
  | 'validated'
  | 'validation_failed'
  | 'validating'
  | 'proposed';

export interface PathNode {
  id: string;
  column: PathColumn;
  kind: PathKind;
  /** Canonical record id (evidence, hypothesis, experiment, investigation, or patch id). */
  refId: string;
  title: string;
  summary: string;
  state: PathState;
}

export type PathRelation = 'cites' | 'targets' | 'supports' | 'contradicts' | 'primary';

export interface PathEdge {
  id: string;
  from: string;
  to: string;
  relation: PathRelation;
  label: string;
  /** The ledger record that states this relationship, when there is one. */
  evidenceId: string | null;
}

export interface EvidencePathModel {
  columns: Array<{ key: PathColumn; title: string; nodes: PathNode[] }>;
  edges: PathEdge[];
  /** Short, data-derived summaries of relationships between adjacent columns. */
  connectors: Array<{ from: PathColumn; to: PathColumn; label: string; recorded: boolean }>;
}

export const COLUMN_TITLE: Record<PathColumn, string> = {
  failure: 'Failure',
  hypotheses: 'Hypotheses',
  experiments: 'Experiments',
  diagnosis: 'Diagnosis',
  remediation: 'Remediation',
};

const FAILURE_FACT = /^(Failing test|Compilation error|CI run used Jest seed|Dependency change|Commit changes)/;

export const nodeId = {
  log: (invId: string) => `log:${invId}`,
  fact: (e: EvidenceRecord) => `evidence:${e.id}`,
  hypothesis: (h: Hypothesis) => `hypothesis:${h.id}`,
  experiment: (e: Experiment) => `experiment:${e.id}`,
  verdict: (invId: string) => `verdict:${invId}`,
  patch: (p: Patch) => `patch:${p.id}`,
};

export function hypothesisState(h: Hypothesis): PathState {
  return h.status === 'supported' ? 'supported' : h.status === 'refuted' ? 'contradicted' : h.status === 'inconclusive' ? 'unresolved' : 'untested';
}

export function experimentState(e: Experiment): PathState {
  if (e.status === 'skipped') return 'skipped';
  if (e.status === 'error') return 'error';
  if (e.status === 'running') return 'running';
  if (e.status === 'queued') return 'queued';
  if (e.backend === 'tavily') return 'completed';
  const r = e.result;
  if (!r || r.attempts.length === 0) return 'queued';
  if (r.failures === 0) return 'tests_passed';
  if (r.failures === r.attempts.length) return 'tests_failed';
  return 'intermittent';
}

export function patchState(p: Patch): PathState {
  return p.status === 'validated' ? 'validated' : p.status === 'failed' || p.status === 'rejected' ? 'validation_failed' : p.status === 'validating' ? 'validating' : 'proposed';
}

function experimentSummary(e: Experiment): string {
  const r = e.result;
  if (e.status === 'skipped') return 'Skipped: not executed';
  if (e.status === 'error') return 'Could not run';
  if (e.backend === 'tavily') return e.observation ?? 'Search';
  if (!r || !r.attempts.length) return `${e.plannedAttempts} planned ${e.plannedAttempts === 1 ? 'run' : 'runs'}`;
  const n = r.attempts.length;
  return `${r.failures}/${n} ${n === 1 ? 'run' : 'runs'} failed`;
}

export function buildEvidencePath(b: Bundle): EvidencePathModel {
  const inv = b.investigation;
  const hyps = b.hypotheses ?? [];
  const experiments = b.experiments ?? [];
  const evidence = b.evidence ?? [];
  const patches = b.patches ?? [];

  // ---- nodes
  const failure: PathNode[] = [
    {
      id: nodeId.log(inv.id),
      column: 'failure',
      kind: 'log',
      refId: inv.id,
      title: inv.source === 'change' ? 'Test result at the changed revision' : 'CI failure',
      summary: inv.failureSignature ?? 'Signature not extracted yet',
      state: 'observed',
    },
    ...evidence
      .filter((e) => e.kind === 'observed_fact' && !e.experimentId && FAILURE_FACT.test(e.title))
      .slice(0, 4)
      .map<PathNode>((e) => ({ id: nodeId.fact(e), column: 'failure', kind: 'observed_fact', refId: e.id, title: e.title, summary: e.detail.split('\n')[0] ?? '', state: 'observed' })),
  ];
  const hypothesisNodes = hyps.map<PathNode>((h) => ({ id: nodeId.hypothesis(h), column: 'hypotheses', kind: 'hypothesis', refId: h.id, title: h.key, summary: h.cause, state: hypothesisState(h) }));
  const diagExps = experiments.filter(isDiagnostic);
  const experimentNodes = diagExps.map<PathNode>((e) => ({ id: nodeId.experiment(e), column: 'experiments', kind: 'experiment', refId: e.id, title: e.title, summary: experimentSummary(e), state: experimentState(e) }));
  const verdictNodes: PathNode[] = [
    {
      id: nodeId.verdict(inv.id),
      column: 'diagnosis',
      kind: 'verdict',
      refId: inv.id,
      title: inv.verdict ? inv.verdict[0].toUpperCase() + inv.verdict.slice(1) : 'No verdict yet',
      summary: inv.verdict ? `${(inv.classification ?? 'unknown').replace(/_/g, ' ')}${inv.confidence ? ` · ${inv.confidence.label} evidence` : ''}` : 'Issued only after experiments run',
      state: inv.verdict ?? 'no_verdict',
    },
  ];
  const patchNodes = patches.map<PathNode>((p) => ({ id: nodeId.patch(p), column: 'remediation', kind: 'patch', refId: p.id, title: p.title, summary: p.validation?.summary ?? (p.status === 'proposed' ? 'Not validated yet' : p.status), state: patchState(p) }));

  const nodes = new Map<string, PathNode>();
  for (const n of [...failure, ...hypothesisNodes, ...experimentNodes, ...verdictNodes, ...patchNodes]) if (!nodes.has(n.id)) nodes.set(n.id, n);

  // ---- edges (recorded relationships only)
  const byKey = new Map(hyps.map((h) => [h.key, h]));
  const edges = new Map<string, PathEdge>();
  const add = (e: PathEdge) => {
    if (nodes.has(e.from) && nodes.has(e.to) && !edges.has(e.id)) edges.set(e.id, e);
  };

  for (const h of hyps) {
    const seenLines = new Set<number>();
    for (const q of h.supporting ?? []) {
      if (!q.verified || !q.logLine || seenLines.has(q.logLine)) continue;
      seenLines.add(q.logLine);
      const fact = evidence.find((e) => nodes.has(`evidence:${e.id}`) && e.provenance?.lines && q.logLine! >= e.provenance.lines[0] && q.logLine! <= e.provenance.lines[1]);
      const from = fact ? `evidence:${fact.id}` : nodeId.log(inv.id);
      add({ id: `cites:${from}:${h.id}`, from, to: nodeId.hypothesis(h), relation: 'cites', label: `cites L${q.logLine}`, evidenceId: fact?.id ?? null });
    }
  }
  const effectPairs = new Set<string>();
  for (const ev of evidence) {
    if (ev.kind !== 'inference' || !ev.experimentId || !ev.hypothesisKey || (ev.effect !== 'supports' && ev.effect !== 'contradicts')) continue;
    const h = byKey.get(ev.hypothesisKey);
    if (!h) continue;
    const from = `experiment:${ev.experimentId}`;
    const to = nodeId.hypothesis(h);
    effectPairs.add(`${from}|${to}`);
    add({ id: `effect:${ev.id}`, from, to, relation: ev.effect, label: ev.effect, evidenceId: ev.id });
  }
  for (const e of diagExps) {
    const h = e.hypothesisKey ? byKey.get(e.hypothesisKey) : undefined;
    if (!h || effectPairs.has(`${nodeId.experiment(e)}|${nodeId.hypothesis(h)}`)) continue;
    add({ id: `targets:${e.id}:${h.id}`, from: nodeId.experiment(e), to: nodeId.hypothesis(h), relation: 'targets', label: 'targets', evidenceId: null });
  }
  const primary = inv.verdict && inv.primaryHypothesis ? byKey.get(inv.primaryHypothesis) : undefined;
  if (primary) add({ id: `primary:${primary.id}`, from: nodeId.hypothesis(primary), to: nodeId.verdict(inv.id), relation: 'primary', label: `primary ${primary.key}`, evidenceId: null });

  const edgeList = [...edges.values()];
  const count = (r: PathRelation) => edgeList.filter((e) => e.relation === r).length;
  const primaryEffects = primary ? edgeList.filter((e) => e.to === nodeId.hypothesis(primary) && (e.relation === 'supports' || e.relation === 'contradicts')) : [];
  const validated = patches.filter((p) => p.status === 'validated').length;
  const failedFix = patches.filter((p) => p.status === 'failed' || p.status === 'rejected').length;

  const connectors: EvidencePathModel['connectors'] = [
    { from: 'failure', to: 'hypotheses', label: count('cites') ? `${count('cites')} verified log ${count('cites') === 1 ? 'citation' : 'citations'}` : 'no verified citations', recorded: count('cites') > 0 },
    {
      from: 'hypotheses',
      to: 'experiments',
      label: [count('supports') && `${count('supports')} supports`, count('contradicts') && `${count('contradicts')} contradicts`, count('targets') && `${count('targets')} targets`].filter(Boolean).join(' · ') || 'no recorded links',
      recorded: count('supports') + count('contradicts') + count('targets') > 0,
    },
    {
      from: 'experiments',
      to: 'diagnosis',
      label: primary
        ? `${primaryEffects.filter((e) => e.relation === 'supports').length} for · ${primaryEffects.filter((e) => e.relation === 'contradicts').length} against ${primary.key}`
        : 'no verdict yet',
      recorded: primaryEffects.length > 0,
    },
    {
      from: 'diagnosis',
      to: 'remediation',
      label: patches.length ? `${validated} validated · ${failedFix} failed${patches.length - validated - failedFix ? ` · ${patches.length - validated - failedFix} pending` : ''}` : 'no candidate fix',
      recorded: false,
    },
  ];

  const cols: PathColumn[] = ['failure', 'hypotheses', 'experiments', 'diagnosis', 'remediation'];
  const all = [...nodes.values()];
  return {
    columns: cols.map((key) => ({ key, title: COLUMN_TITLE[key], nodes: all.filter((n) => n.column === key) })),
    edges: edgeList,
    connectors,
  };
}

/** Edges touching a node, for highlighting related nodes and listing relationships. */
export function edgesFor(model: EvidencePathModel, id: string): PathEdge[] {
  return model.edges.filter((e) => e.from === id || e.to === id);
}

/** Validation experiments recorded for a patch (patchId or the patch's validation ids). */
export function validationExperiments(b: Bundle, p: Patch): Experiment[] {
  const ids = new Set([p.validation?.targetedExperimentId, p.validation?.suiteExperimentId].filter(Boolean));
  return (b.experiments ?? []).filter((e) => e.patchId === p.id || ids.has(e.id));
}
