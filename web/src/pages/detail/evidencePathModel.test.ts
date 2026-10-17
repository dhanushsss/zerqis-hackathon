import { describe, expect, it } from 'vitest';
import type { Bundle } from '../../api';
import codeRegression from '../../test-fixtures/code-regression.json';
import flaky from '../../test-fixtures/flaky-jest.json';
import maven from '../../test-fixtures/maven-dependency.json';
import { buildEvidencePath, type EvidencePathModel } from './evidencePathModel';

const fixtures = { codeRegression, flaky, maven } as unknown as Record<string, Bundle>;
const nodesOf = (m: EvidencePathModel) => m.columns.flatMap((c) => c.nodes);

describe('evidence path adapter: structure', () => {
  it.each(Object.entries(fixtures))('%s: unique stable IDs and edges reference existing nodes', (_n, b) => {
    const m = buildEvidencePath(b);
    const ids = nodesOf(m).map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(m.edges.map((e) => e.id)).size).toBe(m.edges.length);
    for (const e of m.edges) {
      expect(ids).toContain(e.from);
      expect(ids).toContain(e.to);
    }
    expect(m.columns.map((c) => c.key)).toEqual(['failure', 'hypotheses', 'experiments', 'diagnosis', 'remediation']);
  });

  it('is deterministic: the same records produce the same view model', () => {
    for (const b of Object.values(fixtures)) expect(buildEvidencePath(structuredClone(b))).toEqual(buildEvidencePath(structuredClone(b)));
  });

  it('node IDs embed canonical record IDs', () => {
    const b = fixtures.codeRegression;
    const m = buildEvidencePath(b);
    for (const h of b.hypotheses) expect(nodesOf(m).find((n) => n.id === `hypothesis:${h.id}`)?.refId).toBe(h.id);
    for (const p of b.patches) expect(nodesOf(m).find((n) => n.id === `patch:${p.id}`)?.refId).toBe(p.id);
  });
});

describe('evidence path adapter: states come from recorded statuses', () => {
  it('flaky: intermittent repeat with its actual counts, parent also failing, quarantine validated', () => {
    const m = buildEvidencePath(fixtures.flaky);
    const exps = m.columns[2].nodes;
    expect(exps.find((n) => n.title.startsWith('Run the failing test 10×'))).toMatchObject({ state: 'intermittent', summary: '2/10 runs failed' });
    expect(exps.find((n) => n.title.startsWith('Compare against the parent'))).toMatchObject({ state: 'intermittent', summary: '2/3 runs failed' });
    expect(m.columns[4].nodes[0]).toMatchObject({ state: 'validated' });
  });

  it('contradicted hypotheses are marked contradicted, with the contradicting edge from the experiment that recorded it', () => {
    const b = fixtures.codeRegression;
    const m = buildEvidencePath(b);
    const refuted = b.hypotheses.filter((h) => h.status === 'refuted');
    expect(refuted.length).toBeGreaterThan(0);
    for (const h of refuted) {
      expect(m.columns[1].nodes.find((n) => n.refId === h.id)!.state).toBe('contradicted');
      const recorded = b.evidence.filter((e) => e.kind === 'inference' && e.hypothesisKey === h.key && e.effect === 'contradicts' && e.experimentId);
      expect(m.edges.filter((e) => e.to === `hypothesis:${h.id}` && e.relation === 'contradicts').map((e) => e.evidenceId).sort()).toEqual(recorded.map((e) => e.id).sort());
    }
  });

  it('skipped experiments are never represented as passed', () => {
    const m = buildEvidencePath(fixtures.maven);
    const skipped = m.columns[2].nodes.filter((n) => n.state === 'skipped');
    expect(skipped.length).toBeGreaterThanOrEqual(1);
    for (const n of skipped) expect(n.summary).toMatch(/^Skipped/);
  });

  it('distinguishes validated, failed, and proposed fixes', () => {
    const m = buildEvidencePath(fixtures.maven);
    const states = m.columns[4].nodes.map((n) => n.state).sort();
    expect(states).toEqual(['validated', 'validation_failed']);
    const proposed = buildEvidencePath({ ...fixtures.maven, patches: [{ ...fixtures.maven.patches[0], status: 'proposed', validation: null }] });
    expect(proposed.columns[4].nodes[0]).toMatchObject({ state: 'proposed', summary: 'Not validated yet' });
  });

  it('confirmed diagnosis is a separate node from the fix and never linked to it', () => {
    const m = buildEvidencePath(fixtures.maven);
    expect(m.columns[3].nodes[0]).toMatchObject({ state: 'confirmed' });
    expect(m.edges.some((e) => e.from.startsWith('verdict:') || e.to.startsWith('patch:'))).toBe(false);
    expect(m.connectors.find((c) => c.from === 'diagnosis')).toMatchObject({ recorded: false, label: '1 validated · 1 failed' });
  });
});

describe('evidence path adapter: no invented relationships', () => {
  it('draws no supports/contradicts edges without a recorded effect record', () => {
    const b = fixtures.codeRegression;
    const stripped = { ...b, evidence: b.evidence.filter((e) => !(e.kind === 'inference' && e.effect)) };
    const m = buildEvidencePath(stripped);
    expect(m.edges.filter((e) => e.relation === 'supports' || e.relation === 'contradicts')).toHaveLength(0);
  });

  it('ignores unverified citations and effects that reference missing records', () => {
    const b = fixtures.codeRegression;
    const h = b.hypotheses[0];
    const changed: Bundle = {
      ...b,
      hypotheses: [{ ...h, supporting: [{ text: 'made up', logLine: 3, verified: false }] }],
      evidence: [{ ...b.evidence[0], id: 'ev_x', kind: 'inference', effect: 'supports', experimentId: 'exp_missing', hypothesisKey: h.key }],
    };
    const m = buildEvidencePath(changed);
    expect(m.edges.filter((e) => e.relation === 'cites' || e.relation === 'supports')).toHaveLength(0);
  });
});

describe('evidence path adapter: partial data', () => {
  it('handles a queued investigation with no records', () => {
    const b = fixtures.flaky;
    const empty = { ...b, investigation: { ...b.investigation, verdict: null, confidence: null, failureSignature: null, primaryHypothesis: null, status: 'queued' }, hypotheses: [], experiments: [], evidence: [], patches: [], sources: [] } as unknown as Bundle;
    const m = buildEvidencePath(empty);
    expect(m.columns[3].nodes[0]).toMatchObject({ state: 'no_verdict' });
    expect(m.columns[1].nodes).toHaveLength(0);
    expect(m.edges).toHaveLength(0);
  });
  it('tolerates missing arrays', () => {
    const b = { investigation: fixtures.flaky.investigation } as unknown as Bundle;
    expect(() => buildEvidencePath(b)).not.toThrow();
  });
});
