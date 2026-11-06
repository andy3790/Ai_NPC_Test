import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { Engine } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
import { MockAdapter } from '../src/adapters/mock.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { exampleSpec } from '../src/shared/example.js';
import type { AdapterEvent, TurnRequest, TurnResult } from '../src/adapters/types.js';

class CleanupAdapter extends MockAdapter {
  override name = 'codex';
  deleted: string[] = []; failDeletion = false; uncertainDirector = false;
  beforeDelete?: (id: string) => void;
  async deleteSession(id: string) {
    this.beforeDelete?.(id);
    if (this.failDeletion) throw new Error('Temporary cleanup failure');
    this.deleted.push(id); return 'deleted' as const;
  }
  override async turn(r: TurnRequest, emit: (e: AdapterEvent) => void, signal?: AbortSignal): Promise<TurnResult> {
    if (this.uncertainDirector && JSON.parse(r.input).task === 'direct') return { status: 'uncertain', turnId: 'unconfirmed', output: '' };
    return super.turn(r, emit, signal);
  }
}
function setup() {
  const store = new Store(':memory:'), adapter = new CleanupAdapter(); adapter.delayMs = 0;
  const engine = new Engine(store, adapter, '.cache/history-test-cleanup');
  const spec = exampleSpec('mock-model'); delete spec.scenario.environment;
  spec.maxUtterances = 4; spec.variants = [{ ...spec.variants[0], turnPolicy: 'director' }]; spec.evaluation.enabled = false;
  return { store, adapter, engine, spec };
}

test('completed runs delete all Codex sessions once, including overwritten directors, after saving output', async () => {
  const { store, adapter, engine, spec } = setup();
  try {
    adapter.beforeDelete = id => assert.ok(store.list('invocations').filter(c => c.threadId === id).every(c => c.status === 'completed' && c.output));
    const { runs: [run] } = await engine.create(spec); await engine.idle();
    const calls = store.list('invocations', run.id), all = new Set([...calls.map(c => c.threadId), ...Object.values(engine.run(run.id).sessions).map(s => s.threadId)]);
    assert.equal(engine.run(run.id).status, 'completed'); assert.deepEqual(new Set(adapter.deleted), all);
    assert.equal(adapter.deleted.length, all.size);
    await engine.cleanupSessions(); await engine.close(); assert.equal(adapter.deleted.length, all.size);
    assert.equal(store.list('invocations', run.id).length, calls.length);
  } finally { await engine.close(); store.close(); }
});

test('pause keeps NPC memory, releases completed director immediately, and stopped paused run is cleaned', async () => {
  const { store, adapter, engine, spec } = setup();
  try {
    const { runs: [run] } = await engine.create(spec, false);
    await engine.resume(run.id, true); await engine.idle();
    await engine.resume(run.id, true); await engine.idle();
    assert.equal(engine.run(run.id).status, 'paused');
    const calls = store.list('invocations', run.id), director = calls.find(c => c.kind === 'director')!;
    assert.deepEqual(adapter.deleted, [director.threadId]);
    const npcs = Object.values(engine.run(run.id).sessions).map(s => s.threadId);
    await engine.close(); assert.deepEqual(adapter.deleted, [director.threadId]);
    const restarted = new Engine(store, adapter, '.cache/history-test-cleanup');
    await restarted.cleanupSessions(); assert.deepEqual(adapter.deleted, [director.threadId]);
    await restarted.stop(run.id); assert.ok(npcs.every(id => adapter.deleted.includes(id)));
    await restarted.close();
  } finally { await engine.close(); store.close(); }
});

test('uncertain director is retained for reconciliation until explicit stop', async () => {
  const { store, adapter, engine, spec } = setup(); adapter.uncertainDirector = true;
  try {
    const { runs: [run] } = await engine.create(spec); await engine.idle();
    const call = store.list('invocations', run.id).find(c => c.kind === 'director')!;
    assert.equal(engine.run(run.id).status, 'paused'); assert.equal(call.status, 'uncertain');
    await engine.cleanupSessions(); assert.equal(adapter.deleted.length, 0);
    await engine.stop(run.id); assert.ok(adapter.deleted.includes(call.threadId));
  } finally { await engine.close(); store.close(); }
});

test('failed deletion remains retryable across engine restart without changing completed result', async () => {
  const { store, adapter, engine, spec } = setup(); adapter.failDeletion = true;
  try {
    const { runs: [run] } = await engine.create(spec); await engine.idle();
    assert.equal(engine.run(run.id).status, 'completed');
    assert.ok(Object.values(engine.run(run.id).sessionCleanup!).every(c => c.status === 'pending'));
    await engine.close(); adapter.failDeletion = false;
    const restarted = new Engine(store, adapter, '.cache/history-test-cleanup');
    await restarted.cleanupSessions();
    assert.ok(Object.values(restarted.run(run.id).sessionCleanup!).every(c => c.status === 'deleted'));
    assert.ok(store.events(run.id).some(e => e.method === 'session/cleanup' && (e.params as any).error));
    await restarted.close();
  } finally { await engine.close(); store.close(); }
});

test('OpenAI and other adapters are never included in Codex session cleanup', async () => {
  const { store, adapter, engine, spec } = setup(); adapter.name = 'openai';
  try {
    await engine.create(spec); await engine.idle(); await engine.cleanupSessions();
    assert.equal(adapter.deleted.length, 0);
  } finally { await engine.close(); store.close(); }
});

test('Codex deletion rejects foreign/sibling cwd and handles already missing threads idempotently', async () => {
  const previous = process.env.CODEX_BIN; process.env.CODEX_BIN = resolve('tests/fixtures/fake-codex.mjs');
  const root = resolve('.cache/history-test-cleanup-protocol'), adapter = new CodexAdapter(root);
  try {
    const owner = join(root, 'sessions', 'run');
    const id = await adapter.createSession({ model: 'fixture', effort: 'low' }, 'Test', join(owner, 'npc'));
    await assert.rejects(adapter.deleteSession(id, owner + '-other'), /소유 경로/);
    await assert.rejects(adapter.deleteSession(id, join(owner, 'npc', 'other')), /소유 경로/);
    await adapter.resumeSession(id);
    assert.equal(await adapter.deleteSession(id, owner), 'deleted');
    assert.equal(await adapter.deleteSession(id, owner), 'missing');
    await assert.rejects(adapter.resumeSession(id), /no rollout found/);
  } finally { await adapter.close(); if (previous === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = previous; }
});
