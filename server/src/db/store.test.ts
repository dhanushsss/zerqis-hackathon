import { describe, expect, it } from 'vitest';
import { freshInvestigation } from '../pipeline/investigate.js';
import { migrate, openDatabase } from './database.js';
import { Store } from './store.js';

const mk = () => new Store(openDatabase(':memory:'));

describe('persistence', () => {
  it('round-trips investigations and child records, and cascades deletes', () => {
    const s = mk();
    const inv = s.createInvestigation(freshInvestigation({ source: 'demo', repository: 'acme/api', commitSha: 'abc1234' }));
    s.addHypothesis({ id: 'h1', investigationId: inv.id, key: 'H1', cause: 'x', category: 'flaky_test', origin: 'model', supporting: [], contradicting: [], prior: 'high', status: 'open', assessment: null, nextExperiment: null, rank: 0 });
    const e1 = s.addEvidence({ investigationId: inv.id, kind: 'observed_fact', title: 'a', detail: '', hypothesisKey: null, experimentId: null, sourceId: null, effect: null, provenance: { type: 'log', lines: [1, 2] } });
    const e2 = s.addEvidence({ investigationId: inv.id, kind: 'inference', title: 'b', detail: '', hypothesisKey: 'H1', experimentId: null, sourceId: null, effect: 'supports', provenance: { type: 'policy' } });
    expect([e1.seq, e2.seq]).toEqual([1, 2]);
    s.updateInvestigation(inv.id, { status: 'completed', classification: 'flaky_test', verdict: 'confirmed' });
    const b = s.bundle(inv.id)!;
    expect(b.investigation.verdict).toBe('confirmed');
    expect(b.hypotheses[0].key).toBe('H1');
    expect(b.evidence.map((e) => e.title)).toEqual(['a', 'b']);
    expect(s.deleteInvestigation(inv.id)).toBe(true);
    expect(s.listEvidence(inv.id)).toEqual([]);
  });

  it('regression (QA D12 probe): deleting an investigation also deletes its model calls, and only its own', () => {
    const s = mk();
    const a = s.createInvestigation(freshInvestigation({ source: 'demo', repository: 'acme/a', commitSha: 'abc1234' }));
    const b = s.createInvestigation(freshInvestigation({ source: 'demo', repository: 'acme/b', commitSha: 'abc1235' }));
    const call = (id: string, investigationId: string | null) =>
      s.addModelCall({ id, investigationId, step: 'triage', role: 'triage', model: 'm', status: 'ok', startedAt: new Date().toISOString(), durationMs: 1, inputChars: 1, promptTokens: 1, completionTokens: 1, attempts: 1, error: null });
    call('mc_a', a.id);
    call('mc_b', b.id);
    call('mc_test', null);
    expect(s.deleteInvestigation(a.id)).toBe(true);
    expect(s.listModelCalls(a.id)).toEqual([]);
    expect(s.listModelCalls(b.id).map((c) => c.id)).toEqual(['mc_b']);
    expect(s.listModelCalls().map((c) => c.id).sort()).toEqual(['mc_b', 'mc_test']);
  });

  it('the orphan-cleanup migration removes model calls of investigations deleted earlier', () => {
    const db = openDatabase(':memory:');
    db.pragma('user_version = 1');
    db.prepare("INSERT INTO model_calls (id, investigation_id, started_at, data) VALUES ('mc_orphan', 'inv_gone', '2026-01-01', '{}'), ('mc_conn', NULL, '2026-01-01', '{}')").run();
    migrate(db);
    expect(db.prepare('SELECT id FROM model_calls ORDER BY id').all()).toEqual([{ id: 'mc_conn' }]);
  });

  it('filters and searches investigations', () => {
    const s = mk();
    const a = s.createInvestigation(freshInvestigation({ source: 'demo', repository: 'acme/web', commitSha: 'aaa1111' }));
    s.createInvestigation(freshInvestigation({ source: 'github', repository: 'acme/api', commitSha: 'bbb2222' }));
    s.updateInvestigation(a.id, { classification: 'code_regression', status: 'completed' });
    expect(s.listInvestigations({ classification: 'code_regression' }).map((i) => i.repository)).toEqual(['acme/web']);
    expect(s.listInvestigations({ q: 'api' }).map((i) => i.repository)).toEqual(['acme/api']);
    expect(s.listInvestigations({ source: 'github' })).toHaveLength(1);
    expect(s.listInvestigations({ q: '100%_' })).toHaveLength(0);
  });

  it('dedupes runs and webhook deliveries', () => {
    const s = mk();
    s.createInvestigation(freshInvestigation({ source: 'github', repository: 'o/r', commitSha: 'abc1234' }), 'gh:o/r:1:1');
    expect(() => s.createInvestigation(freshInvestigation({ source: 'github', repository: 'o/r', commitSha: 'abc1234' }), 'gh:o/r:1:1')).toThrow();
    expect(s.findByDedupeKey('gh:o/r:1:1')).not.toBeNull();
    expect(s.recordDelivery('d1', 'workflow_run', 'received')).toBe(true);
    expect(s.recordDelivery('d1', 'workflow_run', 'received')).toBe(false);
  });

  it('marks interrupted work as failed on restart', () => {
    const s = mk();
    const inv = s.createInvestigation(freshInvestigation({ source: 'demo', repository: 'o/r', commitSha: 'abc1234', status: 'running' }));
    expect(s.failInterrupted()).toBe(1);
    expect(s.getInvestigation(inv.id)!.status).toBe('failed');
  });

  it('stores only non-secret settings', () => {
    const s = mk();
    s.setSetting('repeatDefault', 12);
    expect(s.getSettings()).toEqual({ repeatDefault: 12 });
  });
});
