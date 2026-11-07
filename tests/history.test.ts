import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store } from '../src/core/store.js';
import { Engine } from '../src/core/engine.js';
import { MockAdapter } from '../src/adapters/mock.js';
import { RunHistoryCatalog } from '../src/core/history.js';
import { createApp } from '../src/server/app.js';
import { exampleSpec } from '../src/shared/example.js';
import { CHARACTER_PERFORMANCE } from '../src/shared/character-performance.js';
import { PROMPT_VERSION } from '../src/core/prompts.js';
import { aggregate } from '../src/core/metrics.js';
import { historyFixture } from './history-fixture.js';

function workspace() { mkdirSync('.cache', { recursive: true }); return mkdtempSync(resolve('.cache/history-test-')); }
function save(path: string, data: string) { mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, data); }

test('external scans pick up late CLI and character comparisons without rescanning live or fixture runs', async () => {
  const root = workspace(), current = join(root, 'data/openai/npc-lab.sqlite');
  const store = new Store(current), engine = new Engine(store, new MockAdapter(), join(root, 'data/openai'));
  const history = new RunHistoryCatalog(engine, { workspace: root });
  try {
    const cli = await historyFixture(join(root, '.cache/history-test-codex-cleanup-12345/npc-lab.sqlite'), 'codex');
    const api = await historyFixture(join(root, '.cache/character-performance/trial/npc-lab.sqlite'), 'openai');
    await historyFixture(join(root, '.cache/history-test-codex-cleanup-fixture/npc-lab.sqlite'), 'mock');
    store.setting('current-only', true);
    const first = history.refresh('external');
    assert.deepEqual(first.errors, []);
    assert.equal(first.sources.filter(s => s.status === 'loaded').length, 2);
    assert.equal(first.sources.find(s => s.path === 'data/openai/npc-lab.sqlite')?.status, 'unchanged');
    assert.deepEqual(new Set(history.list().map(r => r.id)), new Set([cli.detail.run.id, api.detail.run.id]));
    assert.ok(history.detail(cli.detail.run.id).history?.readOnly);
    assert.equal(history.refresh('external').sources.filter(s => s.status === 'loaded').length, 0);
  } finally { history.close(); await engine.close(); store.close(); }
});

test('unified history: read-only database + exports, deduplication, providers, original data and raw metrics', async () => {
  const root = workspace(), foreign = join(root, 'reports/old/npc-lab.sqlite');
  const cli = await historyFixture(foreign, 'codex');
  const api = await historyFixture(join(root, '.cache/api/npc-lab.sqlite'), 'openai', 'per_utterance');
  const exported = await historyFixture(join(root, 'outside.sqlite'), 'codex');
  save(join(root, 'reports/copy/detail.json'), JSON.stringify({ ...cli.detail, summary: { invalid: true }, utterances: [] }));
  save(join(root, 'reports/copy/records.jsonl'), cli.files['records.jsonl']);
  save(join(root, 'reports/jsonl-only/records.jsonl'), exported.files['records.jsonl']);
  save(join(root, 'reports/broken/detail.json'), '{invalid');
  // Active foreign records must remain active on disk; discovery must not recover them.
  const edit = new Store(foreign); edit.patch('runs', cli.detail.run.id, { status: 'running' }); edit.close();
  const original = readFileSync(foreign);
  const store = new Store(join(root, 'current/npc-lab.sqlite')), adapter = new MockAdapter();
  const engine = new Engine(store, adapter, join(root, 'current'));
  const catalog = new RunHistoryCatalog(engine, { workspace: root }); const app = await createApp(engine, { history: catalog });
  try {
    assert.equal(catalog.list().length, 3); assert.equal(catalog.sources().errors.length, 1);
    assert.deepEqual(readFileSync(foreign), original);
    const d = catalog.detail(cli.detail.run.id);
    assert.equal(d.run.status, 'running'); assert.equal(d.history?.readOnly, true);
    assert.equal(d.utterances.length, 3); assert.equal(d.history?.locations.length, 3);
    assert.deepEqual(d.summary.tokens, cli.detail.summary.tokens);
    assert.deepEqual(catalog.events(d.run.id), cli.events);
    assert.deepEqual(catalog.detail(exported.detail.run.id).summary.tokens, exported.detail.summary.tokens);
    assert.deepEqual(catalog.events(exported.detail.run.id), exported.events);
    assert.ok(catalog.sources().sources.some(s => s.status === 'loaded'));
    catalog.refresh(); assert.ok(catalog.sources().sources.some(s => s.status === 'unchanged'));
    const req = (url: string, method: 'GET' | 'POST' | 'PATCH' = 'GET', payload?: any) => app.inject({ url, method, ...(payload ? { payload } : {}) });
    const health = (await req('/api/health')).json();
    assert.equal(health.historyEnabled, true); assert.equal(health.promptVersion, PROMPT_VERSION);
    assert.equal(health.defaultCharacterPerformanceVersion, CHARACTER_PERFORMANCE);
    assert.equal((await req('/api/runs?provider=codex')).json().length, 2);
    assert.equal((await req('/api/runs?provider=openai')).json().length, 1);
    assert.equal((await req('/api/runs?provider=mock')).json().length, 0);
    assert.equal((await req('/api/runs?provider=invalid')).statusCode, 400);
    for (const action of ['resume', 'step', 'stop', 'pause', 'inject', 'evaluate']) {
      const res = await req(`/api/runs/${d.run.id}/${action}`, 'POST', { text: '사건' });
      assert.equal(res.statusCode, 400); assert.match(res.json().error, /보관 기록/);
    }
    assert.equal((await req(`/api/findings/${d.findings[0].id}`, 'PATCH', { review: 'confirmed', note: '' })).statusCode, 400);
    assert.equal(adapter.requests.length, 0);
    const files = (await req(`/api/runs/${api.detail.run.id}/export`)).json();
    const rows = files['records.jsonl'].trim().split('\n').map((v: string) => JSON.parse(v));
    assert.deepEqual(aggregate(rows.filter((v: any) => v.type === 'invocation')).tokens, api.detail.summary.tokens);
    assert.equal(files['invocations.csv'], api.files['invocations.csv']);
    assert.equal(JSON.parse(files['history-source.json']).readOnly, true);
    assert.equal((await req(`/api/runs/${api.detail.run.id}/export.zip`)).rawPayload.readUInt32LE(0), 0x04034b50);
    const groups = (await req(`/api/analysis?runIds=${d.run.id},${api.detail.run.id}`)).json();
    assert.deepEqual([...new Set(groups.map((g: any) => g.adapter))].sort(), ['codex', 'openai']);
    assert.ok(d.summary.tokens.totalTokens !== null); assert.ok(api.detail.summary.tokens.totalTokens !== null);
    assert.equal(groups.reduce((n: number, g: any) => n + g.tokens.totalTokens, 0), d.summary.tokens.totalTokens + api.detail.summary.tokens.totalTokens);
    // Updating one original must refresh only its snapshot and preserve the other IDs.
    const update = new Store(foreign); update.patch('runs', d.run.id, { status: 'completed', name: '이름 갱신' }); update.close();
    assert.equal((await req('/api/history/refresh', 'POST', {})).statusCode, 200);
    assert.equal(catalog.detail(d.run.id).run.name, '이름 갱신'); assert.equal(catalog.list().length, 3);
    // Removing the exact fixture file must not remove its durable archive copy.
    unlinkSync(foreign); catalog.refresh(); assert.equal(catalog.detail(d.run.id).run.name, '이름 갱신');
  } finally { await engine.close(); await app.close(); store.close(); }
  const nextStore = new Store(join(root, 'empty/npc-lab.sqlite')), nextEngine = new Engine(nextStore, new MockAdapter(), join(root, 'empty'));
  const restored = new RunHistoryCatalog(nextEngine, { workspace: root });
  try { assert.equal(restored.list().length, 3); assert.equal(restored.detail(cli.detail.run.id).run.name, '이름 갱신'); }
  finally { restored.close(); restored.close(); await nextEngine.close(); nextStore.close(); }
});

test('current records win duplicates and completed runs are captured for later servers', async () => {
  const root = workspace(), file = join(root, 'custom-location/npc-lab.sqlite');
  const initial = await historyFixture(file, 'mock');
  const store = new Store(file), engine = new Engine(store, new MockAdapter(), join(root, 'runtime'));
  const history = new RunHistoryCatalog(engine, { workspace: root });
  try {
    const id = initial.detail.run.id;
    assert.equal(history.list().length, 1); assert.equal(history.detail(id).history?.readOnly, false); history.assertWritable(id);
    store.patch('runs', id, { name: '현재 저장소 우선' }); engine.emit('change', { runId: id }); assert.equal(history.detail(id).run.name, '현재 저장소 우선');
    const spec = exampleSpec('mock-model'); spec.maxUtterances = 1; spec.evaluation.enabled = false; delete spec.scenario.environment; spec.variants = [spec.variants[0]];
    const result = await engine.create(spec); await engine.idle();
    assert.equal(history.detail(result.runs[0].id).run.status, 'completed');
  } finally { await engine.close(); history.close(); store.close(); }
  unlinkSync(file);
  const fresh = new Store(':memory:'), other = new Engine(fresh, new MockAdapter(), join(root, 'other'));
  const history2 = new RunHistoryCatalog(other, { workspace: root, roots: [] });
  try { assert.equal(history2.list().length, 2); assert.ok(history2.list().every(r => r.history?.readOnly)); assert.equal(history2.detail(initial.detail.run.id).run.name, '현재 저장소 우선'); }
  finally { history2.close(); await other.close(); fresh.close(); }
});
