import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Engine } from './engine.js';
import type { RunHistoryCatalog } from './history.js';
import { exportFiles } from './export.js';
import type { BulkRunDeletionPlan, BulkRunDeletionResult, Run, RunDeletionPlan, RunDetail } from '../shared/types.js';

const rowTables = ['events', 'utterances', 'receipts', 'invocations', 'findings', 'evaluations', 'runs'];
const databaseFile = (path: string) => /\.(sqlite3?|db)$/.test(path);
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const within = (root: string, path: string) => {
  const part = relative(root, path);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith('..\\') && !part.startsWith('../'));
};
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function databaseRunDigest(db: DatabaseSync, id: string) {
  const hash = createHash('sha256');
  for (const table of rowTables) {
    hash.update(table);
    for (const row of db.prepare(`SELECT * FROM ${table} WHERE run_id=? ORDER BY rowid`).iterate(id)) hash.update(JSON.stringify(row));
  }
  return hash.digest('hex');
}

// Never accept a path from an HTTP body. Only catalogue-discovered sources and
// exact, run-owned sidecar IDs may enter a deletion plan. No recursive removals.
export class RunDeletionService {
  constructor(private engine: Engine, private history?: RunHistoryCatalog) {}

  private inspect(id: string, refresh = true) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('잘못된 묶음 ID입니다.');
    const sources = this.history?.deletionSources(id, refresh);
    const detail = this.history ? this.history.detail(id) : this.engine.detail(id);
    const current = !!this.engine.store.get('runs', id);
    const roots = [resolve(this.engine.dataDir), ...(this.engine.store.path === ':memory:' ? [] : [dirname(resolve(this.engine.store.path))]),
      ...(sources ? [sources.workspace, ...sources.roots] : [])];
    const paths = new Set(sources?.paths ?? []);
    if (current && this.engine.store.path !== ':memory:') paths.add(resolve(this.engine.store.path));
    const targets = new Map<string, RunDeletionPlan['targets'][number]>();
    const blockers: string[] = [], signatures: unknown[] = [];
    const { summary: _summary, history: _history, ...snapshot } = detail;
    signatures.push(['snapshot', digest(snapshot)]);
    if (!current) signatures.push(['archive-events', digest(this.history?.events(id) ?? [])]);
    const databases: string[] = [], files: string[] = [], directories: string[] = [];
    const records: { detail: RunDetail; directory: string }[] = [{ detail, directory: resolve(this.engine.dataDir) }];
    const safe = (path: string) => {
      const absolute = resolve(path);
      if (!roots.some(root => within(root, absolute))) throw new Error(`등록된 저장 범위 밖의 경로입니다: ${path}`);
      // Reject symlinks/junctions in every existing component, including the final file.
      let part = absolute;
      while (dirname(part) !== part) {
        if (existsSync(part) && lstatSync(part).isSymbolicLink()) throw new Error(`연결 경로는 삭제할 수 없습니다: ${part}`);
        part = dirname(part);
      }
      if (existsSync(absolute) && !roots.some(root => within(existsSync(root) ? realpathSync(root) : root, realpathSync(absolute)))) {
        throw new Error(`저장 범위를 벗어나는 실제 경로입니다: ${path}`);
      }
      return absolute;
    };
    const add = (path: string, kind: RunDeletionPlan['targets'][number]['kind']) => {
      path = safe(path);
      if (!existsSync(path) || targets.has(path)) return;
      const stat = statSync(path);
      if (kind !== 'database') signatures.push([path, stat.size, stat.mtimeMs]);
      targets.set(path, { path, kind });
      if (kind === 'export' || kind === 'session') files.push(path);
    };
    const checkRun = (run: Run, path: string) => {
      if (run.id !== id || run.snapshotHash !== detail.run.snapshotHash) throw new Error(`묶음 ID 또는 설정이 다른 원본입니다: ${path}`);
      signatures.push([path, run]);
    };
    if (current) try { this.engine.assertDeletable(id); } catch (error) { blockers.push(message(error)); }
    for (const path of paths) {
      try {
        safe(path);
        if (!existsSync(path)) continue;
        if (databaseFile(path)) {
          const own = current && resolve(path) === resolve(this.engine.store.path);
          const db = own ? this.engine.store.db : new DatabaseSync(path, { readOnly: true });
          try {
            if (!own) db.exec('BEGIN');
            const row = db.prepare('SELECT data FROM runs WHERE id=?').get(id);
            if (!row) continue;
            const run = JSON.parse(row.data as string) as Run;
            checkRun(run, path);
            if (!own) {
              const lock = join(dirname(path), 'server.lock');
              if (existsSync(lock)) {
                const pid = Number(readFileSync(lock, 'utf8'));
                if (Number.isSafeInteger(pid) && pid > 0) {
                  let alive = true;
                  try { process.kill(pid, 0); } catch (error: any) { if (error.code === 'ESRCH') alive = false; }
                  if (alive) throw new Error(`원본 저장소의 서버를 종료한 뒤 삭제하세요: ${path}`);
                }
              }
              if (['running', 'queued'].includes(run.status)) throw new Error(`원본 묶음의 실행을 중단한 뒤 삭제하세요: ${path}`);
            }
            const invocations = db.prepare('SELECT data FROM invocations WHERE run_id=?').all(id).map(row => JSON.parse(row.data as string));
            if (invocations.some(call => ['running', 'queued'].includes(call.status))) throw new Error(`처리 중인 호출이 있습니다: ${path}`);
            records.push({ detail: { ...detail, run, invocations }, directory: dirname(path) });
            add(path, 'database'); databases.push(path);
            // Bind confirmation to this run's rows, not the whole DB/WAL mtime.
            // Deleting another selected run must not invalidate this confirmation.
            signatures.push([path, databaseRunDigest(db, id)]);
          } finally { if (!own) { try { db.exec('ROLLBACK'); } finally { db.close(); } } }
        } else {
          const directory = dirname(path);
          // Both importable snapshots must belong to this run before any adjacent
          // generated CSV/JSON is considered owned by the export directory.
          for (const name of ['detail.json', 'records.jsonl', 'config.json', 'history-source.json']) {
            const file = join(directory, name); safe(file);
            if (!existsSync(file)) continue;
            if (name === 'detail.json') checkRun(json(file).run, file);
            else if (name === 'records.jsonl') {
              const rows = readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
              const runs = rows.filter(row => row.type === 'run');
              if (runs.length !== 1 || rows.some(row => row.runId && row.runId !== id)) throw new Error(`다른 묶음이 포함된 JSONL입니다: ${file}`);
              checkRun(runs[0], file);
            } else if (json(file).runId !== id) throw new Error(`다른 묶음의 파일이 있습니다: ${file}`);
          }
          // Delete import anchors last, leaving a verifiable owner if an earlier unlink fails.
          for (const name of [...Object.keys(exportFiles(detail, [])), 'detail.json', 'history-source.json'].sort((a, b) => Number(['detail.json', 'records.jsonl'].includes(a)) - Number(['detail.json', 'records.jsonl'].includes(b)))) {
            add(join(directory, name), 'export');
          }
        }
      } catch (error) { blockers.push(message(error)); }
    }
    for (const record of records) {
      try {
        const { run, invocations } = record.detail;
        if (run.adapter === 'openai') {
          const root = join(record.directory, 'runtime/openai');
          const sessionIds = new Set([...Object.values(run.sessions), ...Object.values(run.helperSessions)].map(s => s.threadId));
          for (const call of invocations) sessionIds.add(call.threadId);
          for (const [kind, ids] of [['sessions', [...sessionIds]], ['calls', invocations.map(call => call.id)]] as const) {
            for (const key of ids) {
              if (!/^[a-zA-Z0-9_-]+$/.test(key)) throw new Error('잘못된 로컬 세션 기록 ID입니다.');
              for (const suffix of ['.json', '.json.tmp']) {
                const file = join(root, kind, key + suffix); safe(file);
                if (!existsSync(file)) continue;
                const data = json(file);
                if ((kind === 'sessions' ? data.id : data.clientMessageId) !== key) throw new Error(`로컬 세션 기록 ID가 다릅니다: ${file}`);
                add(file, 'session');
              }
            }
          }
        }
        // Codex NPC working directories are normally empty. Enumerate only this
        // run's exact directory, checking every path before removing any content.
        const directory = join(record.directory, 'sessions', id);
        const walk = (path: string) => {
          safe(path);
          if (!existsSync(path)) return;
          for (const entry of readdirSync(path, { withFileTypes: true })) {
            const child = join(path, entry.name); safe(child);
            if (entry.isDirectory()) walk(child); else add(child, 'session');
          }
          directories.push(path);
          targets.set(path, { path, kind: 'session' });
        };
        walk(directory);
      } catch (error) { blockers.push(message(error)); }
    }
    if (sources) targets.set(sources.archive, { path: sources.archive, kind: 'archive' });
    if (current && this.engine.store.path === ':memory:') targets.set(':memory:', { path: ':memory:', kind: 'database' });
    const token = createHash('sha256').update(JSON.stringify([id, detail.run, [...targets.keys()].sort(), signatures])).digest('hex');
    const plan: RunDeletionPlan = { runId: id, name: detail.run.name, token, allowed: !blockers.length, blockers,
      targets: [...targets.values()], speechCount: detail.summary.speechCount, invocationCount: detail.invocations.length };
    return { plan, files, directories, databases, current };
  }

  preview(id: string) { return this.inspect(id).plan; }

  previewMany(ids: string[]): BulkRunDeletionPlan {
    const unique = [...new Set(ids)].sort();
    if (!unique.length || unique.some(id => !/^[a-zA-Z0-9_-]{1,100}$/.test(id))) throw new Error('삭제할 묶음 ID를 지정하세요.');
    this.history?.refresh();
    const entries = unique.map(runId => {
      try { return { runId, plan: this.inspect(runId, false).plan, error: null }; }
      catch (error) { return { runId, plan: null, error: message(error) }; }
    });
    return { selectedCount: entries.length, deletableCount: entries.filter(entry => entry.plan?.allowed).length,
      token: digest(entries.map(entry => [entry.runId, entry.plan?.token, entry.plan?.allowed, entry.plan?.blockers, entry.error])), entries };
  }

  deleteMany(ids: string[], token: string): BulkRunDeletionResult {
    const preview = this.previewMany(ids);
    if (preview.token !== token) throw new Error('선택한 삭제 대상 또는 기록이 변경되었습니다. 삭제 창에서 다시 확인하세요.');
    const results: BulkRunDeletionResult['results'] = [];
    for (const entry of preview.entries) {
      if (!entry.plan?.allowed) {
        results.push({ runId: entry.runId, status: 'blocked', error: entry.error ?? entry.plan?.blockers.join('\n') ?? '삭제할 수 없습니다.' });
        continue;
      }
      try { this.delete(entry.runId, entry.plan.token, false); results.push({ runId: entry.runId, status: 'deleted', error: null }); }
      catch (error) { results.push({ runId: entry.runId, status: 'failed', error: message(error) }); }
    }
    return { results };
  }

  delete(id: string, token: string, refresh = true) {
    const prepared = this.inspect(id, refresh);
    if (!prepared.plan.allowed) throw new Error(prepared.plan.blockers.join('\n'));
    if (prepared.plan.token !== token) throw new Error('삭제 대상 기록이 변경되었습니다. 삭제 창을 다시 열어 확인하세요.');
    const opened: DatabaseSync[] = [];
    try {
      // Acquire all foreign write locks before changing files or rows. Other
      // runs in a shared database are preserved by run_id predicates.
      for (const path of prepared.databases) {
        if (prepared.current && resolve(path) === resolve(this.engine.store.path)) continue;
        const db = new DatabaseSync(path); opened.push(db);
        db.exec('PRAGMA busy_timeout=2000; BEGIN IMMEDIATE;');
        const run = db.prepare('SELECT data FROM runs WHERE id=?').get(id);
        if (run && ['running', 'queued'].includes(JSON.parse(run.data as string).status)) throw new Error('원본 실행 상태가 변경되었습니다.');
        for (const table of rowTables) db.prepare(`DELETE FROM ${table} WHERE run_id=?`).run(id);
      }
      for (const file of prepared.files) unlinkSync(file);
      for (const directory of new Set(prepared.directories)) if (existsSync(directory)) rmdirSync(directory);
      for (const db of opened) db.exec('COMMIT');
      // Keep the archive until every original is gone, so a partial failure stays
      // visible and retryable instead of silently hiding surviving data.
      if (prepared.current) this.engine.deleteRun(id, false);
      this.history?.purge(id);
      this.engine.emit('change', { type: 'deleted', runId: id, at: new Date().toISOString() });
      return { deleted: true, runId: id, targets: prepared.plan.targets };
    } catch (error) {
      for (const db of opened) try { db.exec('ROLLBACK'); } catch { /* May already have committed. */ }
      this.engine.emit('change', { runId: '', at: new Date().toISOString() });
      throw new Error(`삭제를 완료하지 못했습니다. 남은 기록을 확인한 뒤 다시 시도하세요. ${message(error)}`);
    } finally { for (const db of opened) db.close(); }
  }
}
