import { randomBytes } from 'node:crypto';
import type { DB } from './database.js';
import type {
  EvidenceRecord,
  Experiment,
  ExternalSource,
  Hypothesis,
  Investigation,
  ModelCall,
  Patch,
} from '../domain/types.js';

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export interface InvestigationFilter {
  q?: string;
  status?: string;
  classification?: string;
  verdict?: string;
  source?: string;
  limit?: number;
}

export interface InvestigationBundle {
  investigation: Investigation;
  hypotheses: Hypothesis[];
  experiments: Experiment[];
  evidence: EvidenceRecord[];
  sources: ExternalSource[];
  patches: Patch[];
  modelCalls: ModelCall[];
}

/** Typed persistence for every Alibi entity. All writes are synchronous (SQLite). */
export class Store {
  constructor(readonly db: DB) {}

  // ---- investigations -------------------------------------------------
  createInvestigation(inv: Investigation, dedupeKey?: string): Investigation {
    this.db
      .prepare(
        `INSERT INTO investigations (id, created_at, updated_at, status, classification, verdict, repository, source, mode, dedupe_key, data)
         VALUES (@id, @createdAt, @updatedAt, @status, @classification, @verdict, @repository, @source, @mode, @dedupeKey, @data)`,
      )
      .run({ ...this.invColumns(inv), dedupeKey: dedupeKey ?? null, data: JSON.stringify(inv) });
    return inv;
  }

  findByDedupeKey(key: string): Investigation | null {
    const row = this.db.prepare('SELECT data FROM investigations WHERE dedupe_key = ?').get(key) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as Investigation) : null;
  }

  getInvestigation(id: string): Investigation | null {
    const row = this.db.prepare('SELECT data FROM investigations WHERE id = ?').get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Investigation) : null;
  }

  updateInvestigation(id: string, patch: Partial<Investigation>): Investigation {
    const current = this.getInvestigation(id);
    if (!current) throw new Error(`Investigation ${id} not found`);
    const next: Investigation = { ...current, ...patch, id, updatedAt: nowIso() };
    this.db
      .prepare(
        `UPDATE investigations SET updated_at=@updatedAt, status=@status, classification=@classification, verdict=@verdict,
         repository=@repository, source=@source, mode=@mode, data=@data WHERE id=@id`,
      )
      .run({ ...this.invColumns(next), data: JSON.stringify(next) });
    return next;
  }

  listInvestigations(filter: InvestigationFilter = {}): Investigation[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.status) {
      where.push('status = @status');
      params.status = filter.status;
    }
    if (filter.classification) {
      where.push('classification = @classification');
      params.classification = filter.classification;
    }
    if (filter.verdict) {
      where.push('verdict = @verdict');
      params.verdict = filter.verdict;
    }
    if (filter.source) {
      where.push('source = @source');
      params.source = filter.source;
    }
    if (filter.q) {
      where.push('(repository LIKE @q OR data LIKE @q)');
      params.q = `%${filter.q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    }
    const sql = `SELECT data FROM investigations ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC LIMIT ${Math.min(Math.max(filter.limit ?? 200, 1), 500)}`;
    const rows = this.db.prepare(sql.replace(/LIKE @q/g, "LIKE @q ESCAPE '\\'")).all(params) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Investigation);
  }

  deleteInvestigation(id: string): boolean {
    return this.db.prepare('DELETE FROM investigations WHERE id = ?').run(id).changes > 0;
  }

  /** Marks investigations that were mid-flight when the process stopped. */
  failInterrupted(): number {
    const rows = this.db
      .prepare(`SELECT id FROM investigations WHERE status IN ('queued','running')`)
      .all() as { id: string }[];
    for (const { id } of rows) {
      this.updateInvestigation(id, {
        status: 'failed',
        stage: 'Interrupted',
        error: 'The server restarted while this investigation was in progress. Re-run it to continue.',
      });
      for (const exp of this.listExperiments(id)) {
        if (exp.status === 'running' || exp.status === 'queued') {
          this.updateExperiment(exp.id, { status: 'error', observation: 'Interrupted by server restart.' });
        }
      }
    }
    return rows.length;
  }

  private invColumns(inv: Investigation) {
    return {
      id: inv.id,
      createdAt: inv.createdAt,
      updatedAt: inv.updatedAt,
      status: inv.status,
      classification: inv.classification,
      verdict: inv.verdict,
      repository: inv.repository,
      source: inv.source,
      mode: inv.mode,
    };
  }

  // ---- child entities (JSON documents) -------------------------------
  private insertChild(table: string, obj: { id: string; investigationId: string }, seq?: number) {
    if (seq === undefined) {
      this.db
        .prepare(`INSERT INTO ${table} (id, investigation_id, data) VALUES (?, ?, ?)`)
        .run(obj.id, obj.investigationId, JSON.stringify(obj));
    } else {
      this.db
        .prepare(`INSERT INTO ${table} (id, investigation_id, seq, data) VALUES (?, ?, ?, ?)`)
        .run(obj.id, obj.investigationId, seq, JSON.stringify(obj));
    }
  }

  private getChild<T>(table: string, id: string): T | null {
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as T) : null;
  }

  private updateChild<T extends { id: string }>(table: string, id: string, patch: Partial<T>): T {
    const current = this.getChild<T>(table, id);
    if (!current) throw new Error(`${table} ${id} not found`);
    const next = { ...current, ...patch, id } as T;
    this.db.prepare(`UPDATE ${table} SET data = ? WHERE id = ?`).run(JSON.stringify(next), id);
    return next;
  }

  private listChildren<T>(table: string, investigationId: string, order = 'rowid'): T[] {
    const rows = this.db
      .prepare(`SELECT data FROM ${table} WHERE investigation_id = ? ORDER BY ${order}`)
      .all(investigationId) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as T);
  }

  addHypothesis(h: Hypothesis): Hypothesis {
    this.insertChild('hypotheses', h);
    return h;
  }
  updateHypothesis(id: string, patch: Partial<Hypothesis>): Hypothesis {
    return this.updateChild<Hypothesis>('hypotheses', id, patch);
  }
  listHypotheses(investigationId: string): Hypothesis[] {
    return this.listChildren<Hypothesis>('hypotheses', investigationId).sort((a, b) => a.rank - b.rank);
  }

  addExperiment(e: Experiment): Experiment {
    const seq = (this.db.prepare('SELECT COUNT(*) AS n FROM experiments WHERE investigation_id = ?').get(e.investigationId) as { n: number }).n;
    this.insertChild('experiments', e, seq);
    return e;
  }
  getExperiment(id: string): Experiment | null {
    return this.getChild<Experiment>('experiments', id);
  }
  updateExperiment(id: string, patch: Partial<Experiment>): Experiment {
    return this.updateChild<Experiment>('experiments', id, patch);
  }
  listExperiments(investigationId: string): Experiment[] {
    return this.listChildren<Experiment>('experiments', investigationId, 'seq');
  }

  addEvidence(e: Omit<EvidenceRecord, 'id' | 'seq' | 'createdAt'>): EvidenceRecord {
    const seq = (this.db.prepare('SELECT COUNT(*) AS n FROM evidence WHERE investigation_id = ?').get(e.investigationId) as { n: number }).n + 1;
    const rec: EvidenceRecord = { ...e, id: newId('ev'), seq, createdAt: nowIso() };
    this.insertChild('evidence', rec, seq);
    return rec;
  }
  listEvidence(investigationId: string): EvidenceRecord[] {
    return this.listChildren<EvidenceRecord>('evidence', investigationId, 'seq');
  }

  addSource(s: ExternalSource): ExternalSource {
    this.insertChild('sources', s);
    return s;
  }
  listSources(investigationId: string): ExternalSource[] {
    return this.listChildren<ExternalSource>('sources', investigationId);
  }

  addPatch(p: Patch): Patch {
    this.insertChild('patches', p);
    return p;
  }
  getPatch(id: string): Patch | null {
    return this.getChild<Patch>('patches', id);
  }
  updatePatch(id: string, patch: Partial<Patch>): Patch {
    return this.updateChild<Patch>('patches', id, patch);
  }
  listPatches(investigationId: string): Patch[] {
    return this.listChildren<Patch>('patches', investigationId);
  }

  addModelCall(c: ModelCall): void {
    this.db
      .prepare('INSERT INTO model_calls (id, investigation_id, started_at, data) VALUES (?, ?, ?, ?)')
      .run(c.id, c.investigationId, c.startedAt, JSON.stringify(c));
  }
  listModelCalls(investigationId?: string): ModelCall[] {
    const rows = (
      investigationId
        ? this.db.prepare('SELECT data FROM model_calls WHERE investigation_id = ? ORDER BY started_at').all(investigationId)
        : this.db.prepare('SELECT data FROM model_calls ORDER BY started_at DESC LIMIT 200').all()
    ) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as ModelCall);
  }

  // ---- logs -------------------------------------------------------------
  saveLog(investigationId: string, text: string): void {
    const lineCount = text.length === 0 ? 0 : text.split('\n').length;
    this.db
      .prepare('INSERT OR REPLACE INTO ci_logs (investigation_id, text, line_count) VALUES (?, ?, ?)')
      .run(investigationId, text, lineCount);
  }
  getLog(investigationId: string): string | null {
    const row = this.db.prepare('SELECT text FROM ci_logs WHERE investigation_id = ?').get(investigationId) as
      | { text: string }
      | undefined;
    return row?.text ?? null;
  }

  // ---- webhooks -------------------------------------------------------------
  /** Returns false when this delivery was already recorded (idempotency). */
  recordDelivery(deliveryId: string, event: string, status: string, detail?: string): boolean {
    const res = this.db
      .prepare(
        'INSERT OR IGNORE INTO webhook_deliveries (delivery_id, event, received_at, status, detail) VALUES (?, ?, ?, ?, ?)',
      )
      .run(deliveryId, event, nowIso(), status, detail ?? null);
    return res.changes > 0;
  }
  updateDelivery(deliveryId: string, status: string, investigationId?: string | null, detail?: string): void {
    this.db
      .prepare('UPDATE webhook_deliveries SET status = ?, investigation_id = COALESCE(?, investigation_id), detail = COALESCE(?, detail) WHERE delivery_id = ?')
      .run(status, investigationId ?? null, detail ?? null, deliveryId);
  }
  listDeliveries(limit = 50): Array<{ deliveryId: string; event: string; receivedAt: string; status: string; investigationId: string | null; detail: string | null }> {
    return (
      this.db
        .prepare('SELECT delivery_id, event, received_at, status, investigation_id, detail FROM webhook_deliveries ORDER BY received_at DESC LIMIT ?')
        .all(limit) as Array<Record<string, string | null>>
    ).map((r) => ({
      deliveryId: r.delivery_id as string,
      event: r.event as string,
      receivedAt: r.received_at as string,
      status: r.status as string,
      investigationId: r.investigation_id,
      detail: r.detail,
    }));
  }

  // ---- repositories ---------------------------------------------------------
  upsertRepository(fullName: string, data: Record<string, unknown>): void {
    this.db
      .prepare(
        `INSERT INTO repositories (full_name, added_at, data) VALUES (?, ?, ?)
         ON CONFLICT(full_name) DO UPDATE SET data = excluded.data`,
      )
      .run(fullName, nowIso(), JSON.stringify(data));
  }
  listRepositories(): Array<{ fullName: string; addedAt: string; data: Record<string, unknown> }> {
    return (this.db.prepare('SELECT full_name, added_at, data FROM repositories ORDER BY added_at DESC').all() as Array<{
      full_name: string;
      added_at: string;
      data: string;
    }>).map((r) => ({ fullName: r.full_name, addedAt: r.added_at, data: JSON.parse(r.data) }));
  }
  removeRepository(fullName: string): boolean {
    return this.db.prepare('DELETE FROM repositories WHERE full_name = ?').run(fullName).changes > 0;
  }

  // ---- settings (non-secret only) ---------------------------------------------
  getSettings(): Record<string, unknown> {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
  }
  setSetting(key: string, value: unknown): void {
    this.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
  }

  bundle(id: string): InvestigationBundle | null {
    const investigation = this.getInvestigation(id);
    if (!investigation) return null;
    return {
      investigation,
      hypotheses: this.listHypotheses(id),
      experiments: this.listExperiments(id),
      evidence: this.listEvidence(id),
      sources: this.listSources(id),
      patches: this.listPatches(id),
      modelCalls: this.listModelCalls(id),
    };
  }
}
