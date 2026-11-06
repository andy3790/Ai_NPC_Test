import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { OpenAIAdapter, responseUsage, responseSchema } from '../src/adapters/openai.js';
import { adapterName } from '../src/adapters/factory.js';
import { Engine } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
import { exampleSpec } from '../src/shared/example.js';
import { spatialExample } from '../src/shared/spatial-example.js';
import { outputSchemas } from '../src/shared/schema.js';
import { exportFiles } from '../src/core/export.js';
import { emptyUsage, UsageTracker } from '../src/core/metrics.js';
import { createApp } from '../src/server/app.js';
import type { AdapterEvent } from '../src/adapters/types.js';
import { openaiFixture } from './fixtures/openai.js';

const model = 'gpt-6-luna', config = { model, effort: 'low' };
const fixture = openaiFixture;
async function setup(mode: 'batched_on_turn' | 'per_utterance' = 'batched_on_turn') {
  await mkdir('.cache', { recursive: true });
  const root = await mkdtemp(resolve('.cache/openai-test-')), api = fixture();
  const adapter = new OpenAIAdapter(root, { apiKey: api.key, fetch: api.fetch });
  const store = new Store(':memory:'), engine = new Engine(store, adapter, root);
  const spec = exampleSpec(model); delete spec.scenario.environment;
  spec.variants = [{ ...spec.variants[0], deliveryMode: mode }]; spec.maxUtterances = 6; spec.evaluation.interval = 6;
  return { root, api, adapter, store, engine, spec };
}

for (const mode of ['batched_on_turn', 'per_utterance'] as const) test(`OpenAI ${mode}: distributed roles use strict schemas, independent chains and measured shared costs`, async () => {
  const { api, store, engine } = await setup(mode);
  try {
    const spec = spatialExample(model); spec.variants = [{ ...spec.variants[1], deliveryMode: mode }]; spec.maxUtterances = 10; spec.evaluation.enabled = true; spec.evaluation.interval = 5;
    Object.assign(spec.eventGenerator!, { intervalSeconds: 1, minGapSeconds: 2, maxProposals: 1 });
    spec.scenario.characters.forEach(c => { c.memories = `PRIVATE_API_${c.id}`; });
    const { runs: [run] } = await engine.create(spec); await engine.idle(); const d = engine.detail(run.id);
    assert.equal(d.run.status, 'completed', d.run.error ?? ''); assert.equal(d.summary.speechCount, 10);
    assert.equal(d.summary.byKind.event_generation.calls, 1); assert.ok(d.summary.byKind.environment.calls > 0); assert.ok(d.evaluations.length > 0);
    assert.ok(d.invocations.every(c => c.usage.totalTokens === 120 && c.actualModel === model && c.durationMs !== null && c.firstOutputMs !== null));
    assert.equal(d.summary.tokens.totalTokens, d.invocations.length * 120);
    assert.ok(d.summary.cost.usd! > 0); assert.ok(Math.abs(Object.values(d.summary.byKind).reduce((n, v) => n + (v.cost.usd ?? 0), 0) - d.summary.cost.usd!) < 1e-8);
    const last = new Map<string, string>();
    const strict = (schema: any) => { if (schema.type === 'object') { assert.equal(schema.additionalProperties, false); assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort()); } for (const value of Object.values(schema)) if (value && typeof value === 'object') { if (Array.isArray(value)) value.forEach(v => typeof v === 'object' && strict(v)); else strict(value); } };
    for (const body of api.requests) {
      const call = d.invocations.find(c => c.id === body.metadata.npc_lab_call_id)!;
      assert.equal(body.previous_response_id, last.get(call.threadId) ?? null); last.set(call.threadId, call.turnId!);
      strict(body.text.format.schema); assert.deepEqual(body.tools, []); assert.equal(body.tool_choice, 'none');
      if (['environment', 'event_generation', 'director'].includes(call.kind)) assert.ok(!body.input.includes('PRIVATE_API_') && !body.instructions.includes('PRIVATE_API_'));
    }
    const files = exportFiles(d, store.events(run.id)); assert.ok(files['invocation-links.csv'].includes('"true"')); assert.ok(!JSON.stringify(files).includes(api.key));
    assert.equal(d.invocations.filter(c => c.kind === 'receive').length, mode === 'per_utterance' ? d.receipts.length : 0);
  } finally { await engine.close(); store.close(); }
});

for (const mode of ['batched_on_turn', 'per_utterance'] as const) test(`OpenAI ${mode}: independent response chains, delivery, raw usage and exports`, async () => {
  const { root, api, adapter, store, engine, spec } = await setup(mode);
  try {
    assert.deepEqual((await adapter.models()).map(m => m.id), [model]);
    const { runs } = await engine.create(spec); await engine.idle(); const d = engine.detail(runs[0].id);
    assert.equal(d.run.status, 'completed', d.run.error ?? undefined);
    assert.equal(d.utterances.length, 6); assert.equal(d.evaluations.length, 1);
    const calls = mode === 'per_utterance' ? 19 : 7;
    assert.equal(d.invocations.length, calls); assert.equal(api.requests.length, calls);
    assert.equal(d.invocations.filter(c => c.kind === 'receive').length, mode === 'per_utterance' ? 12 : 0);
    assert.equal(d.summary.tokens.totalTokens, calls * 120); assert.equal(d.summary.missingUsage, 0);
    assert.ok(d.invocations.every(c => c.usageStatus === 'reported_response' && c.actualModel === model && c.firstOutputMs !== null && c.durationMs !== null));
    assert.ok(d.invocations.every(c => c.usage.cachedInputTokens === 60 && c.usage.reasoningOutputTokens === 5 && c.usage.cacheWriteInputTokens === 10));
    assert.equal(new Set(Object.values(d.run.sessions).map(s => s.threadId)).size, 3);
    const last = new Map<string, string>();
    for (const body of api.requests) {
      const session = body.metadata.npc_lab_session_id;
      assert.equal(body.previous_response_id, last.get(session) ?? null);
      const response = [...api.responses.values()].find(r => r.id === d.invocations.find(c => c.id === body.metadata.npc_lab_call_id)?.turnId)!;
      last.set(session, response.id);
      assert.deepEqual(body.reasoning, { effort: 'low' }); assert.deepEqual(body.tools, []); assert.equal(body.tool_choice, 'none');
      assert.equal(body.text.format.strict, true); assert.equal(body.store, true); assert.equal(body.truncation, 'disabled');
      assert.equal(body.max_output_tokens, 4096);
      const character = spec.scenario.characters.find(c => d.run.sessions[c.id]?.threadId === session);
      if (character) {
        assert.ok(body.instructions.includes(character.memories));
        for (const other of spec.scenario.characters.filter(c => c.id !== character.id)) assert.ok(!body.instructions.includes(other.memories));
      }
    }
    const files = exportFiles(d, store.events(d.run.id));
    assert.ok(files['invocations.csv'].includes('reported_response')); assert.ok(files['records.jsonl'].includes('openai/response.completed'));
    assert.ok(!JSON.stringify(files).includes(api.key));
    for (const kind of ['sessions', 'calls']) for (const file of await readdir(join(root, 'openai', kind))) assert.ok(!(await readFile(join(root, 'openai', kind, file), 'utf8')).includes(api.key));
  } finally { await engine.close(); store.close(); }
});

for (const mode of ['batched_on_turn', 'per_utterance'] as const) test(`OpenAI ${mode}: world engine uses private response chain, strict schema, usage, latency and cost`, async () => {
  const { api, store, engine, spec } = await setup(mode);
  spec.variants[0].environmentMode = 'ai'; spec.worldEngine = { model, effort: 'medium' };
  spec.maxUtterances = 2; spec.evaluation.enabled = false;
  spec.scenario.characters.forEach((c, i) => { c.memories = `PRIVATE_API_MEMORY_${i}`; });
  try {
    const { runs: [run] } = await engine.create(spec); await engine.idle(); const d = engine.detail(run.id);
    assert.equal(d.run.status, 'completed', d.run.error ?? ''); assert.equal(d.run.worldState?.virtualSeconds, 4);
    const requests = api.requests.filter(body => JSON.parse(body.input).task === 'environment');
    assert.equal(requests.length, 2); assert.equal(requests[0].previous_response_id, null);
    const calls = d.invocations.filter(c => c.kind === 'environment');
    assert.equal(requests[1].previous_response_id, calls[0].turnId);
    for (const body of requests) {
      assert.equal(body.text.format.strict, true); assert.equal(body.text.format.schema.additionalProperties, false);
      assert.ok(body.text.format.schema.required.includes('elapsedSeconds')); assert.ok(body.text.format.schema.required.includes('events'));
      assert.deepEqual(body.tools, []); assert.equal(body.reasoning.effort, 'medium');
      assert.ok(!body.instructions.includes('PRIVATE_API_')); assert.ok(!body.input.includes('PRIVATE_API_'));
      assert.deepEqual(Object.keys(JSON.parse(body.input).npcs[0]), ['id', 'name']);
    }
    assert.equal(d.summary.byKind.environment.tokens.totalTokens, 240);
    assert.ok(d.summary.byKind.environment.cost.usd! > 0);
    assert.ok(calls.every(c => c.durationMs !== null && c.firstOutputMs !== null && c.usageStatus === 'reported_response'));
    assert.equal(d.summary.byKind.receive.calls, mode === 'per_utterance' ? 4 : 0);
    assert.equal(d.utterances.length, 2); assert.equal(d.summary.tokens.totalTokens, api.requests.length * 120);
    const files = exportFiles(d, store.events(run.id)); assert.equal(JSON.parse(files['world-state.json']).virtualSeconds, 4);
  } finally { await engine.close(); store.close(); }
});

test('OpenAI quota errors preserve original input for manual retry and redact the key', async () => {
  const { api, store, engine, spec } = await setup(); spec.maxUtterances = 1; spec.evaluation.enabled = false;
  try {
    api.fail('rate'); const { runs } = await engine.create(spec); await engine.idle(); const id = runs[0].id;
    let d = engine.detail(id); assert.equal(d.run.status, 'paused'); assert.equal(d.utterances.length, 0); assert.equal(api.requests.length, 1);
    assert.equal(d.invocations[0].status, 'failed'); assert.equal(d.invocations[0].usage.totalTokens, null); assert.ok(!d.run.error?.includes(api.key));
    await engine.resume(id); await engine.idle(); d = engine.detail(id);
    assert.equal(d.run.status, 'completed'); assert.deepEqual(JSON.parse(api.requests[1].input), JSON.parse(api.requests[0].input));
    assert.equal(d.invocations[1].retryOf, d.invocations[0].id);
  } finally { await engine.close(); store.close(); }
});

test('OpenAI incomplete output is measured but not published; retry keeps the original dialogue payload', async () => {
  const { api, store, engine, spec } = await setup(); spec.maxUtterances = 1; spec.evaluation.enabled = false;
  try {
    api.fail('incomplete'); const { runs } = await engine.create(spec); await engine.idle(); const id = runs[0].id;
    const first = engine.detail(id); assert.equal(first.run.status, 'paused'); assert.equal(first.utterances.length, 0); assert.equal(first.summary.tokens.totalTokens, 120);
    await engine.resume(id); await engine.idle(); const d = engine.detail(id);
    assert.equal(d.run.status, 'completed'); assert.equal(d.summary.tokens.totalTokens, 240);
    assert.equal(api.requests[1].previous_response_id, null); assert.equal(api.requests[1].input, api.requests[0].input);
  } finally { await engine.close(); store.close(); }
});

test('OpenAI dropped stream is recovered after adapter restart by GET, without a second paid POST', async () => {
  const { root, api, store, engine, spec } = await setup(); spec.maxUtterances = 1; spec.evaluation.enabled = false;
  api.fail('drop'); const { runs } = await engine.create(spec); await engine.idle(); const id = runs[0].id;
  assert.equal(engine.detail(id).invocations[0].status, 'uncertain'); await engine.close();
  const restored = new Engine(store, new OpenAIAdapter(root, { apiKey: api.key, fetch: api.fetch }), root);
  try {
    await restored.resume(id); await restored.idle(); const d = restored.detail(id);
    assert.equal(d.run.status, 'completed'); assert.equal(d.utterances.length, 1); assert.equal(api.requests.length, 1); assert.equal(api.retrieved.length, 1);
    assert.equal(d.invocations[0].usage.totalTokens, 120); assert.equal(d.summary.missingUsage, 0);
    assert.equal(d.invocations[0].metadata.reconciled, true);
  } finally { await restored.close(); store.close(); }
});

test('OpenAI unknown request outcome cannot be resumed by blindly retrying', async () => {
  const { api, store, engine, spec } = await setup(); spec.evaluation.enabled = false;
  try {
    api.fail('unknown'); const { runs } = await engine.create(spec); await engine.idle();
    await assert.rejects(engine.resume(runs[0].id), /자동 재전송하지 않습니다/);
    assert.equal(api.requests.length, 1); assert.equal(engine.detail(runs[0].id).run.status, 'paused');
  } finally { await engine.close(); store.close(); }
});

test('OpenAI reports absent usage as null, omits reasoning for non-reasoning models, and honors cancellation', async () => {
  const { api, adapter, store, engine } = await setup();
  try {
    const cfg = { model: 'gpt-4.1-mini', effort: 'none' }, threadId = await adapter.createSession(cfg, 'fixture persona', '');
    const events: AdapterEvent[] = [], request = { threadId, config: cfg, input: '{"task":"speak"}', outputSchema: outputSchemas.speech, clientMessageId: randomUUID(), timeoutMs: 1000 };
    api.fail('missing_usage'); const result = await adapter.turn(request, event => events.push(event));
    assert.equal(result.status, 'completed'); assert.equal(api.requests[0].reasoning, undefined); assert.equal(result.usage, undefined);
    assert.equal(events.filter(e => e.method === 'response/usage').length, 0);
    const cancelled = await adapter.turn({ ...request, clientMessageId: randomUUID() }, () => {}, AbortSignal.abort());
    assert.equal(cancelled.status, 'cancelled'); assert.equal(api.requests.length, 1);
    const tracker = new UsageTracker(null); assert.equal(tracker.result().usage.totalTokens, null);
    tracker.report(responseUsage({ input_tokens: 8, output_tokens: 2, total_tokens: 10 })); tracker.report(responseUsage({ input_tokens: 8, output_tokens: 2, total_tokens: 10 }));
    assert.equal(tracker.result().usage.totalTokens, 10); assert.equal(tracker.result().usage.cachedInputTokens, null);
    assert.deepEqual(responseUsage(undefined), emptyUsage());
  } finally { await engine.close(); store.close(); }
});

test('backend selection keeps Codex default available and allows keyless server startup', async () => {
  assert.equal(adapterName({ adapter: 'codex' }), 'codex'); assert.equal(adapterName({ adapter: 'openai' }), 'openai'); assert.equal(adapterName({ mock: true }), 'mock');
  assert.throws(() => adapterName({ adapter: 'invalid' })); assert.throws(() => adapterName({ adapter: 'openai', mock: true }));
  const adapter = new OpenAIAdapter('.cache/unused', { apiKey: '' });
  try { assert.equal(adapter.keys.status().source, 'missing'); await assert.rejects(adapter.models(), /OPENAI_API_KEY/); }
  finally { await adapter.close(); }
});

test('Responses schema keeps required properties and converts literal receipt to a strict enum', () => {
  const schema = responseSchema(outputSchemas.receive);
  assert.equal(schema.$schema, undefined); assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['received']); assert.deepEqual(schema.properties.received.enum, [true]);
  assert.equal(schema.properties.received.const, undefined);
});

test('OpenAI local API exposes the provider and conservative example settings without disclosing credentials', async () => {
  const { api, store, engine } = await setup(); const app = await createApp(engine);
  const headers = { host: 'localhost' };
  try {
    const health = await app.inject({ url: '/api/health', headers });
    assert.equal(health.json().adapter, 'openai'); assert.ok(!health.body.includes(api.key));
    const example = await app.inject({ url: '/api/example', headers }); const spec = example.json();
    assert.equal(spec.maxUtterances, 6); assert.equal(spec.evaluation.interval, 6); assert.equal(spec.concurrentRuns, 1); assert.equal(spec.maxConcurrentCalls, 1);
    const created = await app.inject({ method: 'POST', url: '/api/experiments', headers, payload: { spec, start: false } });
    assert.equal(created.statusCode, 200); assert.equal(created.json().runs[0].adapter, 'openai');
    assert.equal(created.json().runs[0].status, 'paused'); assert.equal(api.requests.length, 0); assert.ok(!created.body.includes(api.key));
  } finally { await app.close(); await engine.close(); store.close(); }
});

test('OpenAI transport deadline records an uncertain call and never retries automatically', async () => {
  const { root, api, store, engine } = await setup(); let posts = 0;
  const waitingFetch: typeof fetch = async (_url, init) => {
    posts++;
    return new Promise((_resolve, reject) => { const signal = init!.signal!; signal.addEventListener('abort', () => reject(new Error('fixture deadline')), { once: true }); });
  };
  const adapter = new OpenAIAdapter(root, { apiKey: api.key, fetch: waitingFetch, maxOutputTokens: 512 });
  try {
    const threadId = await adapter.createSession(config, 'fixture', ''), id = randomUUID();
    const request = { threadId, config, clientMessageId: id, input: '{"task":"speak"}', outputSchema: outputSchemas.speech, timeoutMs: 20 };
    // Keep the fixture event loop alive while AbortSignal's unref'ed timer fires.
    const keepAlive = setInterval(() => {}, 1000);
    try { const result = await adapter.turn(request, () => {}); assert.equal(result.status, 'uncertain'); }
    finally { clearInterval(keepAlive); }
    assert.equal(posts, 1); assert.equal(await adapter.reconcile(threadId, null, id), null);
    await assert.rejects(adapter.turn(request, () => {}), /다시 전송하지 않습니다/); assert.equal(posts, 1);
  } finally { await adapter.close(); await engine.close(); store.close(); }
});
