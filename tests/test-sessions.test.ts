import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { MockAdapter } from '../src/adapters/mock.js';
import { TestSessions, stopTestRuns, interruptTest, testOwnerKey } from '../scripts/lib/test-sessions.js';
import { Store } from '../src/core/store.js';
import { Engine } from '../src/core/engine.js';
import { exampleSpec } from '../src/shared/example.js';

class DisposableAdapter extends MockAdapter {
  override name = 'codex';
  deleted: string[] = []; fail = false;
  async deleteSession(id: string) {
    if (this.fail) throw new Error('Temporary deletion error');
    this.deleted.push(id); return 'deleted' as const;
  }
}
test('standalone evaluator journals ownership, deletes each sample, and closes unused or failed sessions', async () => {
  const root = mkdtempSync(resolve('.cache/history-test-transient-'));
  const adapter = new DisposableAdapter(), sessions = new TestSessions(adapter, root);
  try {
    const first = await sessions.create({ model: 'mock-model', effort: 'low' }, 'test');
    assert.equal(JSON.parse(readFileSync(join(root, 'sessions.jsonl'), 'utf8').trim()).threadId, first);
    await sessions.release(first);
    const second = await sessions.create({ model: 'mock-model', effort: 'low' }, 'test');
    adapter.fail = true; await assert.rejects(sessions.release(second), /Temporary/);
    adapter.fail = false; assert.deepEqual(await sessions.close(), []);
    assert.deepEqual(adapter.deleted, [first, second]);
    assert.deepEqual(readFileSync(join(root, 'sessions.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line).status), ['created', 'deleted', 'created', 'pending', 'deleted']);
  } finally { await sessions.close(); }
});
test('finishing a standalone test stops paused runs, unlike closing a resumable server', async () => {
  const store = new Store(':memory:'), adapter = new DisposableAdapter(); adapter.delayMs = 0;
  const engine = new Engine(store, adapter, '.cache/history-test-finished');
  try {
    const spec = exampleSpec('mock-model'); delete spec.scenario.environment;
    spec.variants = [spec.variants[0]]; spec.maxUtterances = 3; spec.evaluation.enabled = false;
    const { runs: [run] } = await engine.create(spec, false); await engine.resume(run.id, true); await engine.idle();
    assert.equal(engine.run(run.id).status, 'paused'); assert.equal(adapter.deleted.length, 0);
    await stopTestRuns(engine);
    assert.equal(engine.run(run.id).status, 'stopped'); assert.equal(adapter.deleted.length, spec.scenario.characters.length);
  } finally { await engine.close(); store.close(); }
});

test('opening another disposable sample settles the previous ID first, including deletion retries', async () => {
  const root = mkdtempSync(resolve('.cache/history-test-transient-'));
  const adapter = new DisposableAdapter(), sessions = new TestSessions(adapter, root);
  const start = () => sessions.create({ model: 'mock-model', effort: 'low' }, 'test');
  try {
    const first = await start(); adapter.fail = true;
    await assert.rejects(start(), /deletion error/);
    adapter.fail = false; const second = await start();
    assert.deepEqual(adapter.deleted, [first]); assert.notEqual(second, first);
    const log = readFileSync(join(root, 'sessions.jsonl'), 'utf8').trim().split('\n').map(s => JSON.parse(s).status);
    assert.deepEqual(log, ['created', 'pending', 'deleted', 'created']);
  } finally { await sessions.close(); }
});

test('offline cleanup recognizes only dead standalone runs and their owned sample journals', async () => {
  const workspace = mkdtempSync(resolve('.cache/history-test-cleanup-audit-'));
  const root = join(workspace, '.cache', 'history-test-codex-cleanup-123'); mkdirSync(root, { recursive: true });
  const store = new Store(join(root, 'npc-lab.sqlite')), adapter = new DisposableAdapter(); adapter.delayMs = 0;
  const engine = new Engine(store, adapter, root);
  const spec = exampleSpec('mock-model'); spec.variants = [spec.variants[0]]; spec.evaluation.enabled = false;
  async function pauseAfterOneTurn() {
    const { runs: [run] } = await engine.create(spec, false);
    await engine.resume(run.id, true); await engine.idle(); return engine.run(run.id);
  }
  const ordinary = await pauseAfterOneTurn();
  const dispose = interruptTest(() => engine);
  try {
    const active = await pauseAfterOneTurn(), ended = await pauseAfterOneTurn();
    assert.equal(store.setting(testOwnerKey(ordinary.id)), undefined);
    assert.deepEqual(store.setting(testOwnerKey(active.id)), { pid: process.pid, root });
    const child = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
    assert.equal(child.status, 0); store.setting(testOwnerKey(ended.id), { pid: child.pid, root });
    const orphan = randomUUID(), foreign = randomUUID();
    const record = (threadId: string, cwd: string) => JSON.stringify({ version: 'codex-session-cleanup/1', threadId, cwd, pid: child.pid, status: 'created' });
    writeFileSync(join(root, 'sessions.jsonl'), [record(orphan, root), record(foreign, workspace)].join('\n') + '\n');
    const scan = spawnSync(process.execPath, ['--import', 'tsx', resolve('scripts/cleanup-codex-sessions.ts')], { cwd: workspace, encoding: 'utf8', windowsHide: true });
    assert.equal(scan.status, 0, scan.stderr); const report = JSON.parse(scan.stdout);
    assert.deepEqual(report.skippedSources, []);
    const plan = JSON.parse(readFileSync(report.reportPath, 'utf8')).plan;
    assert.deepEqual(new Set(plan.map((p: { threadId: string }) => p.threadId)), new Set([orphan, ...Object.values(ended.sessions).map(s => s.threadId)]));
    assert.equal(engine.run(ended.id).status, 'paused');
  } finally { await dispose(); await engine.close(); store.close(); }
});

test('CLI interrupt waits for the active call to stop before deleting its sessions', async () => {
  const store = new Store(':memory:'), adapter = new DisposableAdapter(); adapter.delayMs = 50;
  const engine = new Engine(store, adapter, '.cache/history-test-interrupted');
  const dispose = interruptTest(() => engine), previousExit = process.exitCode;
  try {
    const spec = exampleSpec('mock-model'); delete spec.scenario.environment;
    spec.variants = [spec.variants[0]]; spec.maxUtterances = 3; spec.evaluation.enabled = false;
    const { runs: [run] } = await engine.create(spec);
    const deadline = Date.now() + 2000;
    while (!adapter.requests.length) { assert.ok(Date.now() < deadline); await new Promise(r => setTimeout(r, 1)); }
    process.emit('SIGINT'); await engine.idle();
    assert.equal(engine.run(run.id).status, 'stopped');
    assert.equal(store.list('invocations', run.id)[0].status, 'cancelled');
    assert.equal(adapter.deleted.length, spec.scenario.characters.length);
  } finally { await dispose(); await engine.close(); store.close(); process.exitCode = previousExit; }
});
