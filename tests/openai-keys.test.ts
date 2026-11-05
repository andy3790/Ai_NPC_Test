import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { OpenAIAdapter } from '../src/adapters/openai.js';
import { Engine } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
import { createApp } from '../src/server/app.js';
import { exampleSpec } from '../src/shared/example.js';
import { spatialExample } from '../src/shared/spatial-example.js';
import { exportFiles } from '../src/core/export.js';
import { runSnapshot } from '../src/shared/run-snapshot.js';
import { openaiFixture } from './fixtures/openai.js';

const model = 'gpt-6-luna';
async function setup(environment = true) {
  await mkdir('.cache', { recursive: true });
  const root = await mkdtemp(resolve('.cache/openai-keys-')), fixture = openaiFixture();
  const adapter = new OpenAIAdapter(root, { apiKey: environment ? fixture.key : '', fetch: fixture.fetch });
  const store = new Store(join(root, 'test.sqlite')), engine = new Engine(store, adapter, root), app = await createApp(engine);
  const spec = exampleSpec(model); delete spec.scenario.environment;
  spec.variants = [spec.variants[0]]; spec.maxUtterances = 2; spec.evaluation.enabled = false;
  return { root, fixture, adapter, store, engine, app, spec, async close() { await app.close(); await engine.close(); store.close(); } };
}
type App = Awaited<ReturnType<typeof createApp>>;
async function browser(app: App) {
  const response = await app.inject({ url: '/api/openai/key', headers: { host: 'localhost' } });
  assert.equal(response.statusCode, 200); assert.equal(response.headers['cache-control'], 'no-store');
  const cookie = String(response.headers['set-cookie']); assert.match(cookie, /HttpOnly; SameSite=Strict/);
  return { host: 'localhost', cookie: cookie.split(';')[0] };
}
type Headers = Awaited<ReturnType<typeof browser>>;
const setKey = (app: App, headers: Headers, apiKey: string) => app.inject({ method: 'PUT', url: '/api/openai/key', headers, payload: { apiKey } });
async function create(app: App, headers: Headers, spec: unknown) {
  const response = await app.inject({ method: 'POST', url: '/api/experiments', headers, payload: { spec, start: false } });
  assert.equal(response.statusCode, 200, response.body); return response.json().runs[0].id as string;
}
const control = (app: App, headers: Headers, id: string, action = 'resume') => app.inject({ method: 'POST', url: `/api/runs/${id}/${action}`, headers });
const secret = () => 'fixture-browser-' + randomUUID();

test('keyless API server opens history and configuration and prompts before model requests', async () => {
  const f = await setup(false);
  try {
    const headers = await browser(f.app);
    for (const url of ['/api/health', '/api/runs', '/api/history', '/api/config']) assert.equal((await f.app.inject({ url, headers })).statusCode, 200);
    const status = (await f.app.inject({ url: '/api/openai/key', headers })).json();
    assert.deepEqual(status, { source: 'missing', configured: false, environmentAvailable: false });
    for (const url of ['/api/models', '/api/example']) {
      const response = await f.app.inject({ url, headers }); assert.equal(response.statusCode, 400); assert.match(response.json().error, /페이지에서 개인 키/);
    }
    const response = await f.app.inject({ method: 'POST', url: '/api/experiments', headers, payload: { spec: f.spec } });
    assert.equal(response.statusCode, 400); assert.equal(f.store.list('runs').length, 0); assert.equal(f.fixture.authorizations.length, 0);
  } finally { await f.close(); }
});

test('two browsers select independent keys, environment fallback, and immutable credentials for all run roles', async () => {
  const f = await setup();
  try {
    const a = await browser(f.app), b = await browser(f.app), ka = secret(), kb = secret(), replacement = secret();
    [ka, kb, replacement].forEach(key => f.fixture.acceptedKeys.add(key));
    assert.notEqual(a.cookie, b.cookie);
    const environmentRun = await create(f.app, a, f.spec);
    assert.equal((await setKey(f.app, a, ka)).json().source, 'browser');
    assert.equal((await f.app.inject({ url: '/api/openai/key', headers: b })).json().source, 'environment');
    for (const url of ['/api/models', '/api/example']) {
      assert.equal((await f.app.inject({ url, headers: a })).statusCode, 200);
      assert.equal(f.fixture.authorizations.at(-1)?.key, ka);
      assert.equal((await f.app.inject({ url, headers: b })).statusCode, 200);
      assert.equal(f.fixture.authorizations.at(-1)?.key, f.fixture.key);
    }
    const validate = await f.app.inject({ method: 'POST', url: '/api/validate', headers: a, payload: f.spec });
    assert.equal(validate.statusCode, 200); assert.equal(f.fixture.authorizations.at(-1)?.key, ka);
    const spatial = spatialExample(model); spatial.variants = [{ ...spatial.variants[1], turnPolicy: 'director', deliveryMode: 'per_utterance' }];
    spatial.maxUtterances = 8; spatial.evaluation.interval = 4;
    Object.assign(spatial.eventGenerator!, { intervalSeconds: 1, minGapSeconds: 2, maxProposals: 1 });
    const personalRun = await create(f.app, a, spatial);
    assert.equal((await setKey(f.app, b, kb)).statusCode, 200);
    const bRun = await create(f.app, b, f.spec);
    assert.equal((await setKey(f.app, a, replacement)).statusCode, 200);
    const replacementRun = await create(f.app, a, f.spec);
    const cleared = await f.app.inject({ method: 'DELETE', url: '/api/openai/key', headers: a });
    assert.equal(cleared.json().source, 'environment');
    assert.equal((await f.app.inject({ url: '/api/openai/key', headers: b })).json().source, 'browser');
    const fallbackRun = await create(f.app, a, f.spec);
    for (const action of ['resume', 'step', 'inject', 'evaluate']) assert.equal((await control(f.app, b, personalRun, action)).statusCode, 400);
    assert.equal(f.fixture.requests.length, 0);
    const expected = new Map([[environmentRun, f.fixture.key], [personalRun, ka], [bRun, kb], [replacementRun, replacement], [fallbackRun, f.fixture.key]]);
    for (const [id] of expected) assert.equal((await control(f.app, id === bRun ? b : a, id)).statusCode, 200);
    await f.engine.idle();
    for (const [id, key] of expected) {
      const d = f.engine.detail(id); assert.equal(d.run.status, 'completed', d.run.error ?? '');
      for (const call of d.invocations) {
        const request = f.fixture.authorizations.find(r => r.body?.metadata.npc_lab_call_id === call.id);
        assert.equal(request?.key, key); assert.equal(call.usage.totalTokens, 120); assert.ok(call.durationMs !== null);
      }
    }
    const d = f.engine.detail(personalRun);
    assert.deepEqual([...new Set(d.invocations.map(c => c.kind))].sort(), ['director', 'environment', 'evaluation', 'event_generation', 'receive', 'speech']);
    assert.equal(runSnapshot(d.run).apiKeySource, 'browser');
    const exported = JSON.stringify(exportFiles(d, f.store.events(personalRun)));
    for (const key of [f.fixture.key, ka, kb, replacement]) assert.ok(!exported.includes(key));
    assert.ok(!exported.includes(a.cookie.split('=')[1]));
    for (const kind of ['sessions', 'calls']) for (const name of await readdir(join(f.root, 'openai', kind))) {
      const content = await readFile(join(f.root, 'openai', kind, name), 'utf8');
      for (const key of [f.fixture.key, ka, kb, replacement]) assert.ok(!content.includes(key));
    }
    for (const name of (await readdir(f.root)).filter(name => name.startsWith('test.sqlite'))) {
      const bytes = await readFile(join(f.root, name));
      for (const key of [f.fixture.key, ka, kb, replacement]) assert.ok(!bytes.includes(Buffer.from(key)));
    }
  } finally { await f.close(); }
});

test('invalid or revoked personal keys never silently use the environment key; cross-origin writes are rejected', async () => {
  const f = await setup();
  try {
    const headers = await browser(f.app), good = secret(), invalid = secret(); f.fixture.acceptedKeys.add(good);
    const reject = await setKey(f.app, headers, invalid); assert.equal(reject.statusCode, 400); assert.ok(!reject.body.includes(invalid));
    assert.equal(f.adapter.keys.status().source, 'environment');
    assert.equal((await setKey(f.app, headers, good)).statusCode, 200);
    assert.equal((await setKey(f.app, headers, invalid)).statusCode, 400);
    assert.equal((await f.app.inject({ url: '/api/models', headers })).statusCode, 200); assert.equal(f.fixture.authorizations.at(-1)?.key, good);
    const id = await create(f.app, headers, f.spec); f.fixture.acceptedKeys.delete(good);
    const count = f.fixture.authorizations.length;
    assert.equal((await f.app.inject({ url: '/api/models', headers })).statusCode, 400);
    assert.equal((await control(f.app, headers, id)).statusCode, 200); await f.engine.idle();
    assert.equal(f.engine.run(id).status, 'paused'); assert.ok(f.fixture.authorizations.slice(count).every(r => r.key === good));
    assert.ok(!JSON.stringify(f.engine.detail(id)).includes(good));
    for (const attack of [{ origin: 'https://example.com' }, { host: 'example.com' }]) {
      const response = await setKey(f.app, { ...headers, ...attack }, good); assert.equal(response.statusCode, 403);
    }
  } finally { await f.close(); }
});

test('restart drops browser secrets, requires the original key, and reconciles using that key without another paid POST', async () => {
  const f = await setup(), headers = await browser(f.app), key = secret(), otherKey = secret();
  f.fixture.acceptedKeys.add(key); f.fixture.acceptedKeys.add(otherKey);
  await setKey(f.app, headers, key); f.spec.maxUtterances = 1;
  const id = await create(f.app, headers, f.spec); f.fixture.fail('drop');
  await control(f.app, headers, id); await f.engine.idle(); assert.equal(f.engine.detail(id).invocations[0].status, 'uncertain');
  await f.close();
  const store = new Store(join(f.root, 'test.sqlite')), adapter = new OpenAIAdapter(f.root, { apiKey: f.fixture.key, fetch: f.fixture.fetch });
  const engine = new Engine(store, adapter, f.root), app = await createApp(engine);
  try {
    assert.equal((await app.inject({ url: '/api/openai/key', headers })).json().source, 'environment');
    assert.equal((await app.inject({ url: `/api/runs/${id}`, headers })).statusCode, 200);
    const count = f.fixture.authorizations.length;
    const blocked = await control(app, headers, id); assert.equal(blocked.statusCode, 400); assert.match(blocked.json().error, /같은 키를 다시 입력/);
    assert.equal(f.fixture.authorizations.length, count);
    await setKey(app, headers, otherKey); assert.equal((await control(app, headers, id)).statusCode, 400);
    // Losing the browser identity can be recovered by providing the same original key.
    const freshBrowser = await browser(app); await setKey(app, freshBrowser, key);
    assert.equal((await control(app, freshBrowser, id)).statusCode, 200); await engine.idle();
    assert.equal(engine.run(id).status, 'completed'); assert.equal(f.fixture.requests.length, 1);
    assert.equal(f.fixture.retrieved.length, 1);
    assert.ok(f.fixture.authorizations.filter(r => r.url.includes('/responses/')).every(r => r.key === key));
    assert.equal(engine.detail(id).invocations[0].metadata.reconciled, true);
  } finally { await app.close(); await engine.close(); store.close(); }
});

test('candidate key transport errors and malformed response errors cannot reach API responses or stored logs', async () => {
  const f = await setup(false);
  try {
    const headers = await browser(f.app), key = secret(); f.fixture.acceptedKeys.add(key);
    await setKey(f.app, headers, key); const id = await create(f.app, headers, f.spec);
    f.fixture.fail('bad_json'); await control(f.app, headers, id); await f.engine.idle();
    assert.equal(f.engine.run(id).status, 'paused');
    const files = JSON.stringify(exportFiles(f.engine.detail(id), f.store.events(id)));
    assert.ok(!files.includes(key));
    const failing = new OpenAIAdapter(f.root, { apiKey: '', fetch: async () => { throw new Error(`transport exposed ${key}`); } });
    try { await assert.rejects(failing.setBrowserKey('owner', key), error => { assert.ok(!String(error).includes(key)); return true; }); }
    finally { await failing.close(); }
  } finally { await f.close(); }
});
