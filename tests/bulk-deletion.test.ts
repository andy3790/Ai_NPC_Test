import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/core/store.js';
import { Engine } from '../src/core/engine.js';
import { MockAdapter } from '../src/adapters/mock.js';
import { RunHistoryCatalog } from '../src/core/history.js';
import { RunDeletionService } from '../src/core/deletion.js';
import { createApp } from '../src/server/app.js';
import { historyFixture } from './history-fixture.js';
import { exampleSpec } from '../src/shared/example.js';

function workspace() { mkdirSync('.cache', { recursive: true }); return mkdtempSync(resolve('.cache/history-test-bulk-')); }

test('bulk confirmation binds the selection and row contents; same-DB runs and their copies are deleted together', async () => {
  const root = workspace(), file = join(root, 'current/npc-lab.sqlite');
  const first = await historyFixture(file, 'mock'), second = await historyFixture(file, 'mock'), survivor = await historyFixture(file, 'mock');
  const foreign = join(root, 'reports/copy/npc-lab.sqlite'); mkdirSync(dirname(foreign), { recursive: true }); copyFileSync(file, foreign);
  for (const fixture of [first, second]) {
    const path = join(root, 'reports', fixture.detail.run.id); mkdirSync(path, { recursive: true });
    for (const [name, content] of Object.entries(fixture.files)) writeFileSync(join(path, name), content);
  }
  const store = new Store(file), engine = new Engine(store, new MockAdapter(), dirname(file));
  const history = new RunHistoryCatalog(engine, { workspace: root }), app = await createApp(engine, { history });
  const runIds = [first.detail.run.id, second.detail.run.id];
  const preview = async () => (await app.inject({ method: 'POST', url: '/api/runs/deletion-preview', payload: { runIds } })).json();
  const remove = (payload: unknown) => app.inject({ method: 'DELETE', url: '/api/runs', payload: payload as any });
  try {
    const duplicate = (await app.inject({ method: 'POST', url: '/api/runs/deletion-preview', payload: { runIds: [...runIds, runIds[0]] } })).json();
    let plan = await preview(); assert.equal(plan.selectedCount, 2); assert.equal(plan.deletableCount, 2); assert.equal(plan.token, duplicate.token);
    assert.equal((await remove({ runIds, token: plan.token })).statusCode, 400);
    assert.equal((await remove({ runIds: [...runIds, survivor.detail.run.id], confirm: true, token: plan.token })).statusCode, 400);
    // Updating a measured call must invalidate confirmation even without a Run mutation.
    const call = store.list('invocations', runIds[1])[0];
    store.patch('invocations', call.id, { usage: { ...call.usage, inputTokens: (call.usage.inputTokens ?? 0) + 1, totalTokens: (call.usage.totalTokens ?? 0) + 1 } });
    assert.equal((await remove({ runIds, confirm: true, token: plan.token })).statusCode, 400);
    assert.ok(store.get('runs', runIds[0])); assert.ok(store.get('runs', runIds[1]));
    plan = await preview();
    const response = await remove({ runIds: [...runIds].reverse(), confirm: true, token: plan.token });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().results.map((entry: any) => entry.status), ['deleted', 'deleted']);
    assert.deepEqual(store.get('runs', survivor.detail.run.id), survivor.detail.run);
    const db = new DatabaseSync(foreign, { readOnly: true });
    try {
      for (const id of runIds) {
        for (const table of ['runs', 'utterances', 'invocations', 'receipts', 'findings', 'evaluations', 'events']) {
          assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE run_id=?`).get(id)?.n, 0);
          assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE run_id=?`).get(id)?.n, 0);
        }
        assert.equal(existsSync(join(root, 'reports', id, 'records.jsonl')), false);
      }
      assert.ok(db.prepare('SELECT id FROM runs WHERE id=?').get(survivor.detail.run.id));
    } finally { db.close(); }
    history.refresh(); assert.deepEqual(history.list().map(run => run.id), [survivor.detail.run.id]);
  } finally { await app.close(); await engine.close(); store.close(); }
});

test('bulk deletion reports blocked and failed runs independently and permits retrying only the remaining archive', async () => {
  const root = workspace(), file = join(root, 'current/npc-lab.sqlite');
  const store = new Store(file), engine = new Engine(store, new MockAdapter(), dirname(file));
  const spec = exampleSpec('mock-model'); spec.variants = [spec.variants[0]]; spec.repetitions = 3;
  const { runs } = await engine.create(spec, false);
  const [success, failed, active] = runs;
  store.patch('runs', active.id, { status: 'queued' });
  const history = new RunHistoryCatalog(engine, { workspace: root }), deletion = new RunDeletionService(engine, history);
  const purge = history.purge.bind(history), events: any[] = [];
  engine.on('change', event => events.push(event));
  try {
    const ids = [success.id, failed.id, active.id, 'missing-run'];
    const plan = deletion.previewMany(ids);
    assert.equal(plan.selectedCount, 4); assert.equal(plan.deletableCount, 2);
    history.purge = id => { if (id === failed.id) throw new Error('simulated archive failure'); purge(id); };
    const result = deletion.deleteMany(ids, plan.token);
    assert.deepEqual(Object.fromEntries(result.results.map(entry => [entry.runId, entry.status])), {
      [success.id]: 'deleted', [failed.id]: 'failed', [active.id]: 'blocked', 'missing-run': 'blocked',
    });
    assert.ok(history.detail(failed.id)); assert.ok(store.get('runs', active.id));
    assert.equal(history.list().some(run => run.id === success.id), false);
    assert.deepEqual(events.filter(event => event.type === 'deleted').map(event => event.runId), [success.id]);
    history.purge = purge;
    const retry = deletion.previewMany([failed.id]);
    assert.equal(deletion.deleteMany([failed.id], retry.token).results[0].status, 'deleted');
    assert.ok(store.get('runs', active.id));
  } finally { history.purge = purge; history.close(); await engine.close(); store.close(); }
});

test('bulk deletion works without the history catalogue and blocks an empty or changed selection', async () => {
  const store = new Store(':memory:'), engine = new Engine(store, new MockAdapter(), join(workspace(), 'current'));
  const app = await createApp(engine);
  try {
    const spec = exampleSpec('mock-model'); spec.variants = [spec.variants[0]]; spec.repetitions = 2;
    const { runs } = await engine.create(spec, false); const runIds = runs.map(run => run.id);
    assert.equal((await app.inject({ method: 'POST', url: '/api/runs/deletion-preview', payload: { runIds: [] } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/api/runs/deletion-preview', payload: { runIds: ['../data'] } })).statusCode, 400);
    const plan = (await app.inject({ method: 'POST', url: '/api/runs/deletion-preview', payload: { runIds } })).json();
    const rejected = await app.inject({ method: 'DELETE', url: '/api/runs', headers: { origin: 'https://example.com' }, payload: { runIds, token: plan.token, confirm: true } });
    assert.equal(rejected.statusCode, 403); assert.equal(engine.list().length, 2);
    const response = await app.inject({ method: 'DELETE', url: '/api/runs', payload: { runIds, token: plan.token, confirm: true } });
    assert.equal(response.statusCode, 200); assert.ok(response.json().results.every((entry: any) => entry.status === 'deleted'));
    assert.equal(engine.list().length, 0);
  } finally { await app.close(); await engine.close(); store.close(); }
});
