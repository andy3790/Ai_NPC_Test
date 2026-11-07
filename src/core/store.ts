import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DeliveryReceipt, EvaluationFinding, EvaluationRecord, InvocationMetrics, RawEvent, Run, Utterance } from '../shared/types.js';

type Tables = { runs: Run; utterances: Utterance; receipts: DeliveryReceipt; invocations: InvocationMetrics; findings: EvaluationFinding; evaluations: EvaluationRecord };
export class Store {
  db: DatabaseSync;
  private revisions = new Map<string, number>();
  private revisionSequence = 0;
  private transactionRuns: Set<string> | null = null;
  constructor(public path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    for (const table of ['runs', 'utterances', 'receipts', 'invocations', 'findings', 'evaluations']) {
      this.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS ${table}_run ON ${table}(run_id);`);
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS invocations_operation ON invocations(run_id,json_extract(data,'$.operationKey'));
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, invocation_id TEXT, received_at TEXT NOT NULL, method TEXT NOT NULL, params TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_run ON events(run_id);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); PRAGMA user_version=1;`);
  }
  put<K extends keyof Tables>(table: K, value: Tables[K]) {
    const changed = this.db.prepare(`INSERT INTO ${table}(id,run_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data WHERE ${table}.data<>excluded.data RETURNING run_id`)
      .get(value.id, 'runId' in value ? value.runId : value.id, JSON.stringify(value)) as { run_id: string } | undefined;
    if (changed) this.changed(changed.run_id);
    return value;
  }
  revision(runId: string) { return this.revisions.get(runId) ?? 0; }
  attempts(runId: string, key: string): InvocationMetrics[] {
    return this.db.prepare("SELECT data FROM invocations WHERE run_id=? AND json_extract(data,'$.operationKey')=? ORDER BY rowid")
      .all(runId, key).map(row => JSON.parse(String(row.data)));
  }
  private changed(runId: string) {
    this.revisions.set(runId, ++this.revisionSequence);
    this.transactionRuns?.add(runId);
  }
  get<K extends keyof Tables>(table: K, id: string): Tables[K] | undefined {
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  list<K extends keyof Tables>(table: K, runId?: string): Tables[K][] {
    const rows = runId ? this.db.prepare(`SELECT data FROM ${table} WHERE run_id=? ORDER BY rowid`).all(runId) : this.db.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all();
    return rows.map(row => JSON.parse(row.data as string));
  }
  patch<K extends keyof Tables>(table: K, id: string, patch: Partial<Tables[K]>) {
    const old = this.get(table, id); if (!old) throw new Error(`${table}/${id} 없음`);
    return this.put(table, { ...old, ...patch } as Tables[K]);
  }
  remove(table: keyof Tables, id: string) {
    const removed = this.db.prepare(`DELETE FROM ${table} WHERE id=? RETURNING run_id`).get(id) as { run_id: string } | undefined;
    if (removed) this.changed(removed.run_id);
  }
  deleteRun(id: string) {
    this.transaction(() => {
      for (const table of ['events', 'utterances', 'receipts', 'invocations', 'findings', 'evaluations', 'runs']) {
        this.db.prepare(`DELETE FROM ${table} WHERE run_id=?`).run(id);
      }
      this.changed(id);
    });
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    const changedRuns = new Set<string>(); this.transactionRuns = changedRuns;
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) {
      this.db.exec('ROLLBACK');
      // A summary may have been read inside the transaction. Its revision must
      // become stale again after rollback restores the previously stored data.
      this.transactionRuns = null;
      for (const runId of changedRuns) this.changed(runId);
      throw e;
    } finally { this.transactionRuns = null; }
  }
  event(runId: string, invocationId: string | null, method: string, params: unknown) {
    this.db.prepare('INSERT INTO events(run_id,invocation_id,received_at,method,params) VALUES(?,?,?,?,?)').run(runId, invocationId, new Date().toISOString(), method, JSON.stringify(params ?? null));
  }
  events(runId: string): RawEvent[] {
    return this.db.prepare('SELECT * FROM events WHERE run_id=? ORDER BY id').all(runId).map((r: any) => ({ id: r.id, runId: r.run_id, invocationId: r.invocation_id, receivedAt: r.received_at, method: r.method, params: JSON.parse(r.params) }));
  }
  setting(key: string, value?: unknown): any {
    if (value !== undefined) this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return row ? JSON.parse(row.value as string) : undefined;
  }
  close() { this.db.close(); }
}
