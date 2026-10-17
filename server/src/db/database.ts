import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = Database.Database;

/**
 * Ordered schema migrations, applied by PRAGMA user_version. Entity tables keep
 * queryable columns alongside a `data` JSON document holding the typed record.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE investigations (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    status TEXT NOT NULL,
    classification TEXT,
    verdict TEXT,
    repository TEXT NOT NULL,
    source TEXT NOT NULL,
    mode TEXT NOT NULL,
    dedupe_key TEXT,
    data TEXT NOT NULL
  );
  CREATE INDEX idx_inv_created ON investigations(created_at DESC);
  CREATE UNIQUE INDEX idx_inv_dedupe ON investigations(dedupe_key) WHERE dedupe_key IS NOT NULL;

  CREATE TABLE hypotheses (id TEXT PRIMARY KEY, investigation_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE, data TEXT NOT NULL);
  CREATE INDEX idx_hyp_inv ON hypotheses(investigation_id);

  CREATE TABLE experiments (id TEXT PRIMARY KEY, investigation_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE, seq INTEGER NOT NULL, data TEXT NOT NULL);
  CREATE INDEX idx_exp_inv ON experiments(investigation_id, seq);

  CREATE TABLE evidence (id TEXT PRIMARY KEY, investigation_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE, seq INTEGER NOT NULL, data TEXT NOT NULL);
  CREATE INDEX idx_ev_inv ON evidence(investigation_id, seq);

  CREATE TABLE sources (id TEXT PRIMARY KEY, investigation_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE, data TEXT NOT NULL);
  CREATE INDEX idx_src_inv ON sources(investigation_id);

  CREATE TABLE patches (id TEXT PRIMARY KEY, investigation_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE, data TEXT NOT NULL);
  CREATE INDEX idx_patch_inv ON patches(investigation_id);

  CREATE TABLE model_calls (id TEXT PRIMARY KEY, investigation_id TEXT, started_at TEXT NOT NULL, data TEXT NOT NULL);
  CREATE INDEX idx_mc_inv ON model_calls(investigation_id);

  CREATE TABLE ci_logs (investigation_id TEXT PRIMARY KEY REFERENCES investigations(id) ON DELETE CASCADE, text TEXT NOT NULL, line_count INTEGER NOT NULL);

  CREATE TABLE webhook_deliveries (
    delivery_id TEXT PRIMARY KEY,
    event TEXT NOT NULL,
    received_at TEXT NOT NULL,
    status TEXT NOT NULL,
    investigation_id TEXT,
    detail TEXT
  );

  CREATE TABLE repositories (full_name TEXT PRIMARY KEY, added_at TEXT NOT NULL, data TEXT NOT NULL);

  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
];

export function openDatabase(file: string): DB {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

export function migrate(db: DB): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}
