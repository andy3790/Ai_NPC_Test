import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Store } from '../src/core/store.js';
import { Engine } from '../src/core/engine.js';
import { MockAdapter } from '../src/adapters/mock.js';
import { RunHistoryCatalog } from '../src/core/history.js';
import { RunDeletionService } from '../src/core/deletion.js';
import { createApp } from '../src/server/app.js';
import { exampleSpec } from '../src/shared/example.js';
import { historyFixture } from './history-fixture.js';

function workspace() { mkdirSync('.cache', { recursive: true }); return mkdtempSync(resolve('.cache/history-test-management-')); }
function save(path: string, content: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); }

test('confirmed deletion removes all run rows, archive, known exports and API sidecars without removing other runs', async () => {
  const root = workspace(), file = join(root, 'current/npc-lab.sqlite');
  const target = await historyFixture(file, 'openai');
  const survivor = await historyFixture(file, 'mock');
  const foreign = join(root, 'reports/previous/npc-lab.sqlite'); mkdirSync(dirname(foreign), { recursive: true }); copyFileSync(file, foreign);
  const exportDir = join(root, 'reports/export');
  for (const [name, text] of Object.entries(target.files)) save(join(exportDir, name), text);
  save(join(exportDir, 'detail.json'), JSON.stringify(target.detail));
  save(join(exportDir, 'my-notes.txt'), '사용자가 만든 별도 파일');
  const session = Object.values(target.detail.run.sessions)[0];
  const sessionFile = join(root, 'current/runtime/openai/sessions', session.threadId + '.json');
  const callFile = join(root, 'current/runtime/openai/calls', target.detail.invocations[0].id + '.json');
  save(sessionFile, JSON.stringify({ id: session.threadId }));
  save(callFile, JSON.stringify({ clientMessageId: target.detail.invocations[0].id }));
  const store = new Store(file), engine = new Engine(store, new MockAdapter(), dirname(file));
  const history = new RunHistoryCatalog(engine, { workspace: root });
  const app = await createApp(engine, { history });
  const id = target.detail.run.id;
  try {
    engine.summary(id); engine.emit('change', { runId: id }); // Pending capture must not resurrect a deletion.
    const preview = () => app.inject({ method: 'GET', url: `/api/runs/${id}/deletion` });
    let plan = (await preview()).json();
    assert.equal(plan.allowed, true, JSON.stringify(plan.blockers));
    assert.equal(plan.token, (await preview()).json().token, 'preview is stable without mutations');
    assert.ok(plan.targets.some((target: any) => target.path === foreign));
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/runs/${id}`, payload: { token: plan.token } })).statusCode, 400);
    assert.ok(store.get('runs', id));
    store.patch('runs', id, { name: '확인 중 변경됨' });
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/runs/${id}`, payload: { confirm: true, token: plan.token } })).statusCode, 400);
    plan = (await preview()).json();
    const result = await app.inject({ method: 'DELETE', url: `/api/runs/${id}`, payload: { confirm: true, token: plan.token } });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().deleted, true);
    for (const table of ['runs', 'utterances', 'receipts', 'invocations', 'findings', 'evaluations', 'events']) {
      assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE run_id=?`).get(id)?.n, 0);
    }
    const db = new DatabaseSync(foreign, { readOnly: true });
    try {
      for (const table of ['runs', 'utterances', 'receipts', 'invocations', 'findings', 'evaluations', 'events']) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE run_id=?`).get(id)?.n, 0);
      assert.ok(db.prepare('SELECT id FROM runs WHERE id=?').get(survivor.detail.run.id));
    } finally { db.close(); }
    assert.deepEqual(store.get('runs', survivor.detail.run.id), survivor.detail.run);
    for (const name of Object.keys(target.files)) assert.equal(existsSync(join(exportDir, name)), false, name);
    assert.equal(existsSync(join(exportDir, 'detail.json')), false);
    assert.equal(readFileSync(join(exportDir, 'my-notes.txt'), 'utf8'), '사용자가 만든 별도 파일');
    assert.equal(existsSync(sessionFile), false); assert.equal(existsSync(callFile), false);
    history.refresh(); assert.equal(history.list().some(run => run.id === id), false);
    assert.throws(() => history.detail(id), /없습니다/);
    assert.equal((await app.inject({ method: 'GET', url: `/api/runs/${id}/export` })).statusCode, 400);
  } finally { await app.close(); await engine.close(); store.close(); }
  const next = new Store(file), nextEngine = new Engine(next, new MockAdapter(), dirname(file));
  const restored = new RunHistoryCatalog(nextEngine, { workspace: root });
  try { assert.deepEqual(restored.list().map(run => run.id), [survivor.detail.run.id]); }
  finally { restored.close(); await nextEngine.close(); next.close(); }
});

test('foreign-only and archive-only records can be truly deleted; mismatched exports block every mutation', async () => {
  const root = workspace(), original = join(root, 'reports/old/npc-lab.sqlite');
  const target = await historyFixture(original, 'codex');
  const store = new Store(':memory:'), engine = new Engine(store, new MockAdapter(), join(root, 'current'));
  const history = new RunHistoryCatalog(engine, { workspace: root });
  const deletion = new RunDeletionService(engine, history), id = target.detail.run.id;
  try {
    const plan = deletion.preview(id); assert.equal(plan.allowed, true);
    deletion.delete(id, plan.token);
    const db = new DatabaseSync(original, { readOnly: true });
    try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n, 0); } finally { db.close(); }
    assert.equal(history.list().length, 0);

    const archiveOnly = await historyFixture(original, 'codex'); history.refresh(); unlinkSync(original);
    deletion.delete(archiveOnly.detail.run.id, deletion.preview(archiveOnly.detail.run.id).token);
    assert.equal(history.list().length, 0);

    const invalid = await historyFixture(original, 'codex');
    const dir = join(root, 'reports/export');
    for (const [name, content] of Object.entries(invalid.files)) save(join(dir, name), content);
    save(join(dir, 'config.json'), JSON.stringify({ runId: 'some-other-run' }));
    history.refresh();
    const blocked = deletion.preview(invalid.detail.run.id);
    assert.equal(blocked.allowed, false); assert.match(blocked.blockers.join(' '), /다른 묶음/);
    assert.throws(() => deletion.delete(invalid.detail.run.id, blocked.token), /다른 묶음/);
    assert.ok(existsSync(join(dir, 'records.jsonl'))); assert.equal(history.list().length, 1);
  } finally { history.close(); await engine.close(); store.close(); }
});

test('active runs and foreign servers are protected; a locked DB fails before files are deleted', async () => {
  const root = workspace(), original = join(root, 'reports/old/npc-lab.sqlite');
  const target = await historyFixture(original, 'codex');
  const dir = join(root, 'reports/export');
  for (const [name, content] of Object.entries(target.files)) save(join(dir, name), content);
  const store = new Store(':memory:'), adapter = new MockAdapter(); adapter.delayMs = 10;
  const engine = new Engine(store, adapter, join(root, 'current'));
  const history = new RunHistoryCatalog(engine, { workspace: root }); const deletion = new RunDeletionService(engine, history);
  try {
    const spec = exampleSpec('mock-model'); spec.maxUtterances = 1; spec.evaluation.enabled = false; spec.variants = [spec.variants[0]];
    const { runs } = await engine.create(spec);
    assert.equal(deletion.preview(runs[0].id).allowed, false);
    await engine.idle(); const pausedPlan = deletion.preview(runs[0].id); assert.equal(pausedPlan.allowed, true, pausedPlan.blockers.join('\n'));
    save(join(dirname(original), 'server.lock'), String(process.pid));
    assert.equal(deletion.preview(target.detail.run.id).allowed, false);
    unlinkSync(join(dirname(original), 'server.lock'));
    const plan = deletion.preview(target.detail.run.id);
    const locked = new DatabaseSync(original); locked.exec('BEGIN IMMEDIATE');
    try {
      assert.throws(() => deletion.delete(target.detail.run.id, plan.token), /삭제를 완료하지 못했습니다/);
      assert.ok(existsSync(join(dir, 'records.jsonl')));
      assert.ok(history.detail(target.detail.run.id));
    } finally { locked.exec('ROLLBACK'); locked.close(); }
    const retry = deletion.preview(target.detail.run.id);
    deletion.delete(target.detail.run.id, retry.token);
    assert.equal(history.list().some(run => run.id === target.detail.run.id), false);
  } finally { history.close(); await engine.close(); store.close(); }
});

test('symlink/junction export paths cannot delete files outside the registered workspace', async () => {
  const root = workspace(), outside = workspace();
  const target = await historyFixture(join(root, 'reports/old/npc-lab.sqlite'), 'codex');
  for (const [name, content] of Object.entries(target.files)) save(join(outside, name), content);
  symlinkSync(outside, join(root, 'reports/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const store = new Store(':memory:'), engine = new Engine(store, new MockAdapter(), join(root, 'current'));
  const history = new RunHistoryCatalog(engine, { workspace: root, roots: [join(root, 'reports/linked')] });
  try {
    const service = new RunDeletionService(engine, history), plan = service.preview(target.detail.run.id);
    assert.equal(plan.allowed, false); assert.match(plan.blockers.join(' '), /연결 경로/);
    assert.throws(() => service.delete(target.detail.run.id, plan.token));
    assert.ok(existsSync(join(outside, 'records.jsonl')));
  } finally { history.close(); await engine.close(); store.close(); }
});

test('scenario snapshot survives config edits and restart; list and downloadable settings resolve NPC overrides', async () => {
  const root = workspace(), file = join(root, 'current/npc-lab.sqlite');
  const store = new Store(file), engine = new Engine(store, new MockAdapter(), dirname(file));
  const app = await createApp(engine);
  let id = '';
  const original = exampleSpec('mock-model'); original.variants = [original.variants[0]];
  original.scenario.characters[0].effort = 'high'; original.variants[0].effort = 'low';
  const snapshot = structuredClone(original.scenario);
  try {
    const { runs } = await engine.create(original, false); id = runs[0].id;
    original.scenario.name = '수정한 현재 설정'; original.scenario.world = '나중에 바뀐 세계관';
    original.scenario.characters[0].speechStyle = '나중에 바뀐 말투';
    store.setting('lastSpec', original);
    assert.deepEqual(engine.detail(id).run.spec.scenario, snapshot);
    const item = engine.list()[0];
    assert.equal(item.scenario.name, snapshot.name); assert.equal(item.npcConfigs[0].effort, 'high'); assert.equal(item.npcConfigs[1].effort, 'low');
    const response = await app.inject(`/api/runs/${id}/config.json`);
    assert.equal(response.statusCode, 200); assert.deepEqual(response.json().spec.scenario, snapshot);
    assert.equal(response.json().resolvedNpcConfigs[0].effort, 'high'); assert.ok(response.json().promptVersion);
  } finally { await app.close(); await engine.close(); store.close(); }
  const next = new Store(file), restarted = new Engine(next, new MockAdapter(), dirname(file));
  try { assert.deepEqual(restarted.detail(id).run.spec.scenario, snapshot); }
  finally { await restarted.close(); next.close(); }
});

test('an archive write failure keeps remaining history visible and sends deletion only after retry succeeds', async () => {
  const root = workspace(), file = join(root, 'current/npc-lab.sqlite');
  const target = await historyFixture(file, 'mock');
  const store = new Store(file), engine = new Engine(store, new MockAdapter(), dirname(file));
  const history = new RunHistoryCatalog(engine, { workspace: root });
  const deletion = new RunDeletionService(engine, history), id = target.detail.run.id;
  const events: any[] = []; engine.on('change', event => events.push(event));
  const purge = history.purge.bind(history);
  try {
    history.purge = () => { throw new Error('simulated archive write failure'); };
    assert.throws(() => deletion.delete(id, deletion.preview(id).token), /삭제를 완료하지 못했습니다/);
    assert.equal(store.get('runs', id), undefined);
    assert.ok(history.detail(id)); assert.ok(history.list().some(run => run.id === id));
    assert.equal(events.some(event => event.type === 'deleted'), false, 'failed deletion must not evict surviving archive from browser caches');
    history.purge = purge;
    deletion.delete(id, deletion.preview(id).token);
    assert.equal(history.list().some(run => run.id === id), false);
    assert.equal(events.filter(event => event.type === 'deleted').length, 1);
  } finally { history.purge = purge; history.close(); await engine.close(); store.close(); }
});
