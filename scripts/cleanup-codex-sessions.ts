import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { CodexAdapter } from '../src/adapters/codex.js';
import { disposableSessions, SESSION_CLEANUP_VERSION } from '../src/core/session-cleanup.js';
import type { InvocationMetrics, Run } from '../src/shared/types.js';

// Migration of existing test sessions. Read experiment DBs only; never construct
// Engine (which performs run recovery) or modify their conversation records.
const { values } = parseArgs({ options: { apply: { type: 'boolean', default: false } } });
const workspace = realpathSync(resolve('.'));
const inside = (path: string) => { const rel = relative(workspace, path); return !!rel && rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../') && !isAbsolute(rel); };
const sources = new Set<string>();
const evalDirectories = new Set<string>();
const walk = (dir: string, depth = 0) => {
  if (depth > 9 || !existsSync(dir) || !inside(realpathSync(dir))) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || ['node_modules', '.git', 'sessions', 'runtime'].includes(entry.name) || /^(history-test-|history-ui-)/.test(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, depth + 1);
    else if (entry.name === 'npc-lab.sqlite' || entry.name === 'npc-history.sqlite') sources.add(path);
    else if (entry.name === 'plan.json') evalDirectories.add(dir);
  }
};
for (const name of ['data', 'reports', '.cache']) walk(join(workspace, name));
const candidates = new Map<string, { roots: Set<string>; runIds: Set<string> }>();
const protectedIds = new Set<string>(), skippedSources: { path: string; reason: string }[] = [];
let codexRuns = 0;
const ingest = (run: Run, calls: InvocationMetrics[], dataDir: string, busy = false) => {
  if (run.adapter !== 'codex' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(run.id)) return;
  codexRuns++;
  const owned = new Set([...Object.values(run.sessions), ...Object.values(run.helperSessions)].map(s => s.threadId));
  calls.forEach(c => owned.add(c.threadId));
  // Ignore synthetic fixture IDs and never infer ownership from cwd alone.
  const eligible = new Set(disposableSessions({ ...run, sessionCleanup: undefined }, calls));
  for (const id of owned) {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) continue;
    if (busy || !eligible.has(id)) { protectedIds.add(id); continue; }
    const entry = candidates.get(id) ?? { roots: new Set<string>(), runIds: new Set<string>() };
    entry.roots.add(join(dataDir, 'sessions', run.id)); entry.runIds.add(run.id); candidates.set(id, entry);
  }
};
for (const source of sources) {
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000; BEGIN;');
    if (source.endsWith('npc-history.sqlite')) {
      for (const row of db.prepare('SELECT detail_json, source FROM history_runs').all()) {
        const origin = resolve(workspace, String(row.source)); if (!inside(origin)) continue;
        const detail = JSON.parse(String(row.detail_json));
        // Current DBs are authoritative. An archive-only copy remains useful
        // when the test directory was removed; cwd is still verified by Codex.
        if (!sources.has(origin)) ingest(detail.run, detail.invocations, dirname(origin));
      }
    } else {
      let busy = false; const lock = join(dirname(source), 'server.lock');
      if (existsSync(lock)) {
        const pid = Number(readFileSync(lock, 'utf8'));
        if (pid > 0) try { process.kill(pid, 0); busy = true; } catch (e: any) { if (e.code !== 'ESRCH') busy = true; }
      }
      for (const row of db.prepare('SELECT data FROM runs').all()) {
        const run = JSON.parse(String(row.data));
        if (run.adapter !== 'codex') continue;
        const calls = db.prepare('SELECT data FROM invocations WHERE run_id=? ORDER BY rowid').all(run.id).map(r => JSON.parse(String(r.data)));
        ingest(run, calls, dirname(source), busy);
      }
    }
    db.exec('COMMIT;');
  } catch (error) { skippedSources.push({ path: relative(workspace, source), reason: String(error) }); }
  finally { db.close(); }
}
for (const directory of evalDirectories) {
  const plan = JSON.parse(readFileSync(join(directory, 'plan.json'), 'utf8'));
  if (plan.adapter !== 'codex') continue;
  const ids = new Set<string>();
  const journal = join(directory, 'sessions.jsonl'), events = join(directory, 'events.jsonl');
  let journalActive = false, hasJournal = false;
  if (existsSync(journal)) for (const line of readFileSync(journal, 'utf8').split(/\r?\n/).filter(Boolean)) {
    const record = JSON.parse(line); hasJournal = true;
    if (typeof record.threadId === 'string') ids.add(record.threadId);
    if (Number.isSafeInteger(record.pid) && record.pid > 0) try { process.kill(record.pid, 0); journalActive = true; }
    catch (e: any) { if (e.code !== 'ESRCH') journalActive = true; }
  }
  for (const line of (existsSync(events) ? readFileSync(events, 'utf8') : '').split(/\r?\n/).filter(Boolean)) {
    const record = JSON.parse(line);
    for (const event of record.events ?? []) {
      const id = event.params?.threadId ?? event.params?.thread?.id;
      if (typeof id === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) ids.add(id);
    }
  }
  const manifest = join(directory, 'manifest.json');
  const finished = !journalActive && (hasJournal || existsSync(manifest) && ['completed', 'incomplete'].includes(JSON.parse(readFileSync(manifest, 'utf8')).status));
  for (const id of ids) {
    if (!finished) { protectedIds.add(id); continue; }
    const entry = candidates.get(id) ?? { roots: new Set<string>(), runIds: new Set<string>() };
    entry.roots.add(directory); entry.runIds.add(relative(workspace, directory)); candidates.set(id, entry);
  }
}
for (const id of protectedIds) candidates.delete(id);
const outputDir = resolve('.cache/codex-session-cleanup'); mkdirSync(outputDir, { recursive: true });
const report: any = { version: SESSION_CLEANUP_VERSION, at: new Date().toISOString(), apply: values.apply,
  sources: sources.size, codexRunCopies: codexRuns, protectedSessions: protectedIds.size, skippedSources, candidates: candidates.size,
  plan: [...candidates].map(([threadId, entry]) => ({ threadId, roots: [...entry.roots], runIds: [...entry.runIds] })), results: [] };
const reportPath = join(outputDir, values.apply ? 'applied.json' : 'preview.json');
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2));
save();
if (values.apply && candidates.size) {
  const adapter = new CodexAdapter(join(outputDir, 'runtime'));
  try {
    for (const [threadId, entry] of candidates) {
      let status = 'pending', error: string | undefined;
      for (const root of entry.roots) {
        try { status = await adapter.deleteSession(threadId, root); error = undefined; break; }
        catch (e) { error = String(e); }
      }
      report.results.push({ threadId, runIds: [...entry.runIds], status, ...(error ? { error } : {}) }); save();
      console.log(JSON.stringify({ processed: report.results.length, total: candidates.size, status }));
    }
  } finally { await adapter.close(); report.cliVersion = adapter.version; save(); }
}
console.log(JSON.stringify({ ...report, plan: undefined, results: undefined, counts: Object.fromEntries(['deleted', 'missing', 'pending'].map(s => [s, report.results.filter((r: any) => r.status === s).length])), reportPath }, null, 2));
if (report.results.some((r: any) => r.status === 'pending') || skippedSources.length) process.exitCode = 1;
