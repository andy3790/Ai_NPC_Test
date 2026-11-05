import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { Engine } from './engine.js';
import { buildRunDetail } from './detail.js';
import { matchesProvider, toRunListItem } from './summary.js';
import { exportFiles } from './export.js';
import { aggregateCost, PRICING_DATE } from './pricing.js';
import { aggregate } from './metrics.js';
import type { RawEvent, Run, RunDetail, RunHistory, RunListItem, RunSummary } from '../shared/types.js';

interface ArchiveRow { run_id: string; run_json: string; summary_json: string; detail_json: string; events_json: string; source: string; priority: number; archived_at: string }
interface SourceState { path: string; status: 'loaded' | 'unchanged' | 'error'; runs: number; error?: string }
const tables = ['utterances', 'invocations', 'findings', 'evaluations', 'receipts'] as const;
const stamp = () => new Date().toISOString();

// Durable snapshots; external databases are opened read-only and never given to
// Engine, whose constructor intentionally performs active-run recovery.
export class RunHistoryCatalog {
  private db: DatabaseSync;
  private signatures = new Map<string, string>();
  private states: SourceState[] = [];
  private captureTimer?: ReturnType<typeof setTimeout>;
  private changedRuns = new Set<string>();
  private workspace: string;
  private archiveFile: string;
  private closed = false;
  constructor(private engine: Engine, options: { workspace?: string; archive?: string; roots?: string[] } = {}) {
    this.workspace = resolve(options.workspace ?? '.');
    this.archiveFile = resolve(options.archive ?? join(this.workspace, 'data/history/npc-history.sqlite'));
    mkdirSync(dirname(this.archiveFile), { recursive: true });
    this.db = new DatabaseSync(this.archiveFile);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS history_runs (run_id TEXT PRIMARY KEY, run_json TEXT NOT NULL, summary_json TEXT NOT NULL, detail_json TEXT NOT NULL, events_json TEXT NOT NULL, source TEXT NOT NULL, priority INTEGER NOT NULL, archived_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS history_locations (run_id TEXT NOT NULL, path TEXT NOT NULL, PRIMARY KEY(run_id,path));`);
    this.roots = [...new Set([join(this.workspace, 'data'), join(this.workspace, 'reports'), join(this.workspace, '.cache'), ...(options.roots ?? [])])];
    this.refresh();
    this.updateSavedCosts();
    engine.on('change', this.onChange);
  }
  private roots: string[];
  private updateSavedCosts() {
    // An archive may be the only copy of a run. Refresh derived summaries even
    // when its original DB or export is no longer available to the scanner.
    const rows = this.db.prepare(`SELECT run_id, summary_json, detail_json FROM history_runs
      WHERE json_extract(summary_json, '$.cost.pricingDate') IS NOT ? OR json_extract(summary_json, '$.byKind.environment') IS NULL OR json_extract(summary_json, '$.byKind.event_generation') IS NULL`).all(PRICING_DATE);
    const update = this.db.prepare('UPDATE history_runs SET summary_json=? WHERE run_id=?');
    for (const row of rows) {
      const { run, invocations } = JSON.parse(row.detail_json as string) as RunDetail;
      const summary = JSON.parse(row.summary_json as string) as RunSummary;
      summary.cost = aggregateCost(invocations, run.adapter);
      summary.byKind.environment = aggregate(invocations.filter(call => call.kind === 'environment'), run.adapter);
      summary.byKind.event_generation = aggregate(invocations.filter(call => call.kind === 'event_generation'), run.adapter);
      for (const kind of Object.keys(summary.byKind) as (keyof RunSummary['byKind'])[]) {
        summary.byKind[kind].cost = aggregateCost(invocations.filter(call => call.kind === kind), run.adapter);
      }
      update.run(JSON.stringify(summary), row.run_id);
    }
  }
  private label(path: string) { return relative(this.workspace, resolve(path)).replaceAll('\\', '/') || '.'; }
  private onChange = (event: { runId: string }) => {
    const run = this.engine.store.get('runs', event.runId);
    if (!run || !['completed', 'stopped', 'paused'].includes(run.status)) return;
    this.changedRuns.add(run.id);
    if (this.captureTimer) clearTimeout(this.captureTimer);
    this.captureTimer = setTimeout(() => { this.captureTimer = undefined; this.captureChanged(); }, 600);
    this.captureTimer.unref();
  };
  private captureChanged() {
    for (const id of this.changedRuns) {
      const detail = this.engine.detail(id);
      if (detail.invocations.some(c => ['running', 'queued'].includes(c.status))) continue;
      this.save(detail, this.engine.store.events(id), this.label(this.engine.store.path), 400);
    }
    this.changedRuns.clear();
  }
  private save(detail: RunDetail, events: RawEvent[], source: string, priority: number) {
    const run = detail.run;
    if (!run?.id || !run.spec?.scenario || !run.variant || !['codex', 'openai', 'mock'].includes(run.adapter)) throw new Error('지원하는 실행 기록 형식이 아닙니다.');
    const old = this.db.prepare('SELECT * FROM history_runs WHERE run_id=?').get(run.id) as ArchiveRow | undefined;
    if (old && JSON.parse(old.run_json).snapshotHash !== run.snapshotHash) throw new Error(`동일 실행 ID의 설정 해시가 충돌합니다: ${run.id}`);
    this.db.prepare('INSERT OR IGNORE INTO history_locations(run_id,path) VALUES(?,?)').run(run.id, source);
    if (old && old.source !== source) {
      if (old.priority > priority) return;
      if (old.priority === priority) {
        const previous = JSON.parse(old.detail_json) as RunDetail;
        const latest = (d: RunDetail) => Math.max(0, ...[d.run.createdAt, d.run.completedAt, ...d.invocations.map(c => c.completedAt ?? c.startedAt ?? c.queuedAt)].filter(Boolean).map(t => Date.parse(t!)));
        if (latest(previous) > latest(detail)) return;
      }
    }
    const { history: _history, ...stored } = detail;
    this.db.prepare(`INSERT INTO history_runs VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET
      run_json=excluded.run_json, summary_json=excluded.summary_json, detail_json=excluded.detail_json, events_json=excluded.events_json, source=excluded.source, priority=excluded.priority, archived_at=excluded.archived_at`)
      .run(run.id, JSON.stringify(run), JSON.stringify(stored.summary), JSON.stringify(stored), JSON.stringify(events), source, priority, stamp());
  }
  private discover(errors: SourceState[]) {
    const files = new Set<string>(); const visited = new Set<string>();
    if (this.engine.store.path !== ':memory:' && existsSync(this.engine.store.path)) files.add(resolve(this.engine.store.path));
    const walk = (path: string, depth: number) => {
      try {
      if (!existsSync(path) || depth > 5) return;
      const real = realpathSync(path); if (visited.has(real)) return; visited.add(real);
      if (statSync(path).isFile()) { if (/\.(sqlite3?|db)$|[\\/](detail\.json|records\.jsonl)$/.test(path)) files.add(resolve(path)); return; }
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || ['node_modules', '.git', 'dist', 'history', 'github-ready-check', 'runtime', 'sessions', 'screenshots', 'releases', 'publication-prep'].includes(entry.name) || /^(openai-test-|history-test-|history-ui-)/.test(entry.name)) continue;
        if (entry.isDirectory() || /\.(sqlite3?|db)$/.test(entry.name) || ['detail.json', 'records.jsonl'].includes(entry.name)) walk(join(path, entry.name), depth + 1);
      }
      } catch (error) { errors.push({ path: this.label(path), status: 'error', runs: 0, error: error instanceof Error ? error.message : String(error) }); }
    };
    for (const root of this.roots) walk(resolve(root), 0);
    return [...files].filter(file => file !== this.archiveFile).sort((a, b) => this.priority(b) - this.priority(a) || a.localeCompare(b));
  }
  private priority(path: string) { return resolve(path) === resolve(this.engine.store.path) ? 400 : /\.(sqlite3?|db)$/.test(path) ? 300 : path.endsWith('detail.json') ? 200 : 100; }
  private signature(path: string) {
    return [path, path + '-wal'].map(file => existsSync(file) ? `${statSync(file).size}:${statSync(file).mtimeMs}` : '-').join('|');
  }
  private importDatabase(path: string) {
    const source = new DatabaseSync(path, { readOnly: true }); let count = 0;
    try {
      source.exec('PRAGMA busy_timeout=5000; BEGIN;');
      const runs = source.prepare('SELECT data FROM runs ORDER BY rowid').all().map(row => JSON.parse(row.data as string) as Run);
      for (const run of runs) {
        const data: any = { run };
        for (const table of tables) data[table] = source.prepare(`SELECT data FROM ${table} WHERE run_id=? ORDER BY rowid`).all(run.id).map(row => JSON.parse(row.data as string));
        const events = source.prepare('SELECT * FROM events WHERE run_id=? ORDER BY id').all(run.id).map((row: any) => ({ id: row.id, runId: row.run_id, invocationId: row.invocation_id, receivedAt: row.received_at, method: row.method, params: JSON.parse(row.params) }));
        this.save(buildRunDetail(data), events, this.label(path), this.priority(path)); count++;
      }
      source.exec('COMMIT;'); return count;
    } finally { source.close(); }
  }
  private importExport(path: string) {
    let data: any; let events: RawEvent[] = [];
    if (path.endsWith('records.jsonl')) {
      const rows = readFileSync(path, 'utf8').replace(/^\uFEFF/, '').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      const values = (type: string) => rows.filter(row => row.type === type).map(({ type: _type, ...row }) => row);
      const runs = values('run'); if (runs.length !== 1) throw new Error('JSONL에는 묶음 1개의 기록이 필요합니다.');
      data = { run: runs[0], utterances: values('utterance'), invocations: values('invocation'), receipts: values('receipt'), findings: values('finding'), evaluations: values('evaluation') };
      events = values('raw_event');
    } else {
      data = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
      // The adjacent JSONL is the complete raw-event export of this snapshot.
      const jsonl = join(dirname(path), 'records.jsonl');
      if (existsSync(jsonl)) {
        const rows = readFileSync(jsonl, 'utf8').replace(/^\uFEFF/, '').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
        events = rows.filter(row => row.type === 'raw_event' && row.runId === data.run?.id).map(({ type: _type, ...row }) => row);
      }
    }
    this.save(buildRunDetail(data), events, this.label(path), this.priority(path)); return 1;
  }
  refresh() {
    const states: SourceState[] = [];
    for (const path of this.discover(states)) {
      const label = this.label(path);
      try {
        const signature = this.signature(path);
        if (this.signatures.get(path) === signature) { states.push({ path: label, status: 'unchanged', runs: Number(this.db.prepare('SELECT COUNT(*) AS n FROM history_locations WHERE path=?').get(label)?.n ?? 0) }); continue; }
        this.db.exec('BEGIN IMMEDIATE');
        let count: number;
        try { count = /\.(sqlite3?|db)$/.test(path) ? this.importDatabase(path) : this.importExport(path); this.db.exec('COMMIT'); }
        catch (error) { this.db.exec('ROLLBACK'); throw error; }
        this.signatures.set(path, signature); states.push({ path: label, status: 'loaded', runs: count });
      } catch (error) { states.push({ path: label, status: 'error', runs: 0, error: error instanceof Error ? error.message : String(error) }); }
    }
    this.states = states; return this.sources();
  }
  private locations(id: string) { return this.db.prepare('SELECT path FROM history_locations WHERE run_id=? ORDER BY path').all(id).map(row => row.path as string); }
  private origin(id: string, current: boolean, archivedAt?: string): RunHistory {
    const locations = this.locations(id);
    if (current && !locations.includes(this.label(this.engine.store.path))) locations.unshift(this.label(this.engine.store.path));
    return { readOnly: !current, kind: current ? 'current' : 'archive', locations, ...(archivedAt ? { archivedAt } : {}) };
  }
  list(provider?: string): RunListItem[] {
    const current = this.engine.store.list('runs'); const activeIds = new Set(current.map(run => run.id));
    const archived = (this.db.prepare('SELECT run_id,run_json,summary_json,archived_at FROM history_runs').all() as unknown as ArchiveRow[])
      .filter(row => !activeIds.has(row.run_id)).map(row => ({ run: JSON.parse(row.run_json) as Run, summary: JSON.parse(row.summary_json) as RunSummary, history: this.origin(row.run_id, false, row.archived_at) }));
    const live = current.filter(run => matchesProvider(run, provider))
      .map(run => toRunListItem(run, this.engine.summary(run.id), this.origin(run.id, true)));
    const saved = archived.filter(({ run }) => matchesProvider(run, provider))
      .map(({ run, summary, history }) => toRunListItem(run, summary, history));
    return [...live, ...saved].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  detail(id: string): RunDetail {
    if (this.engine.store.get('runs', id)) return { ...this.engine.detail(id), history: this.origin(id, true) };
    const row = this.db.prepare('SELECT * FROM history_runs WHERE run_id=?').get(id) as ArchiveRow | undefined;
    if (!row) throw new Error('대화 묶음이 없습니다.');
    return { ...JSON.parse(row.detail_json), summary: JSON.parse(row.summary_json), history: this.origin(id, false, row.archived_at) };
  }
  events(id: string): RawEvent[] {
    if (this.engine.store.get('runs', id)) return this.engine.store.events(id);
    const row = this.db.prepare('SELECT events_json FROM history_runs WHERE run_id=?').get(id);
    if (!row) throw new Error('대화 묶음이 없습니다.'); return JSON.parse(row.events_json as string);
  }
  exports(id: string) {
    const detail = this.detail(id);
    return { ...exportFiles(detail, this.events(id)), 'history-source.json': JSON.stringify({ runId: id, ...detail.history }, null, 2) };
  }
  assertWritable(id: string) { if (this.detail(id).history?.readOnly) throw new Error('보관 기록은 조회·비교·내보내기 전용입니다. 실행 제어는 원본 저장소의 서버에서 사용하세요.'); }
  sources() { return { archive: this.label(this.archiveFile), sources: this.states, runs: Number(this.db.prepare('SELECT COUNT(*) AS n FROM history_runs').get()?.n ?? 0), errors: this.states.filter(s => s.status === 'error') }; }
  close() { if (this.closed) return; this.closed = true; this.engine.off('change', this.onChange); if (this.captureTimer) clearTimeout(this.captureTimer); this.captureChanged(); this.db.close(); }
}
