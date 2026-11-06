import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { getModelCatalog, getModelPricing, installModelCatalog, isModelEnabled, modelCatalogSchema, PRICING_REVISION } from '../src/shared/model-catalog.js';
import { loadModelCatalog } from '../src/core/load-model-catalog.js';
import { estimateCost } from '../src/core/pricing.js';
import { OpenAIAdapter } from '../src/adapters/openai.js';
import { openaiFixture } from './fixtures/openai.js';
import { Store } from '../src/core/store.js';
import { Engine } from '../src/core/engine.js';
import { exampleSpec } from '../src/shared/example.js';
import { createApp } from '../src/server/app.js';
import type { InvocationMetrics } from '../src/shared/types.js';

const entry = () => ({ id: 'fixture-added-model', enabled: true,
  api: { efforts: ['none' as const], defaultEffort: 'none' as const, reasoning: false },
  pricing: { input: 3, cached: .25, output: 7, longContext: { aboveInputTokens: 1000, input: 8, cached: .5, output: 11 } } });
const call = (inputTokens = 1000) => ({ model: 'fixture-added-model', actualModel: null, metadata: { adapter: 'openai' },
  status: 'completed', startedAt: '2026-11-06T00:00:00Z', usageStatus: 'reported_response',
  usage: { inputTokens, outputTokens: 100, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningOutputTokens: 0, totalTokens: inputTokens + 100 },
}) as unknown as InvocationMetrics;

test('catalogue rejects duplicate IDs, bad rates, typos and inconsistent efforts atomically', () => {
  const original = getModelCatalog(), before = PRICING_REVISION;
  const sample = { ...original, models: [entry()] };
  const invalid: unknown[] = [
    { ...sample, models: [entry(), entry()] },
    { ...sample, pricingDate: '2026-99-99' },
    { ...sample, models: [{ ...entry(), pricing: { input: -1, cached: 0, output: 2 } }] },
    { ...sample, models: [{ ...entry(), pricing: { input: 1, cached: 0 } }] },
    { ...sample, models: [{ ...entry(), enable: true }] },
    { ...sample, models: [{ ...entry(), api: { efforts: ['low'], defaultEffort: 'high', reasoning: true } }] },
    { ...sample, models: [{ ...entry(), api: { efforts: ['low'], defaultEffort: 'low', reasoning: false } }] },
  ];
  for (const value of invalid) { assert.throws(() => installModelCatalog(value)); assert.equal(PRICING_REVISION, before); }
  assert.deepEqual(getModelCatalog(), original);
  assert.equal(modelCatalogSchema.parse(sample).models.length, 1);
});

test('adding, disabling and repricing a model requires data only; disabled rates and explicit long rates remain usable', async () => {
  const original = getModelCatalog(); const sample = { ...original, models: [entry()] };
  await mkdir('.cache', { recursive: true }); const root = await mkdtemp(resolve('.cache/catalog-test-')), file = join(root, 'models.json');
  try {
    await writeFile(file, JSON.stringify(sample)); loadModelCatalog(file);
    assert.equal(isModelEnabled(entry().id), true); assert.equal(estimateCost(call()).usd, .0037);
    assert.equal(estimateCost(call(1001)).usd, .009108);
    const version = PRICING_REVISION;
    sample.models[0].pricing.input = 4; // No date bump is needed to refresh caches.
    sample.models[0].enabled = false;
    await writeFile(file, '\uFEFF' + JSON.stringify(sample)); loadModelCatalog(file);
    assert.equal(isModelEnabled(entry().id), false); assert.equal(estimateCost(call()).usd, .0047);
    assert.notEqual(PRICING_REVISION, version); assert.equal(getModelPricing(entry().id)!.output, 7);
    assert.equal(getModelPricing('unknown-model'), null); assert.equal(getModelPricing('constructor'), null);
    await writeFile(file, '{ malformed'); assert.throws(() => loadModelCatalog(file), /모델 설정/);
    assert.equal(estimateCost(call()).usd, .0047, 'invalid reload keeps the last valid catalogue');
  } finally { installModelCatalog(original); }
});

test('model API uses the same runtime catalogue as pricing and exposes it without requiring a paid model call', async () => {
  const original = getModelCatalog(); installModelCatalog({ ...original, models: [...original.models, entry()] });
  await mkdir('.cache', { recursive: true }); const root = await mkdtemp(resolve('.cache/catalog-api-'));
  const fixture = openaiFixture();
  const fetcher: typeof fetch = async (...args) => {
    const response = await fixture.fetch(...args);
    if (String(args[0]).endsWith('/models')) return Response.json({ data: [...(await response.json() as any).data, { id: entry().id }] });
    return response;
  };
  const adapter = new OpenAIAdapter(root, { apiKey: fixture.key, fetch: fetcher }), store = new Store(':memory:'), engine = new Engine(store, adapter, root);
  const app = await createApp(engine);
  try {
    const models = await adapter.models();
    assert.ok(models.some(m => m.id === entry().id)); assert.ok(models.every(m => !m.id.startsWith('gpt-4.1-mini')));
    const spec = exampleSpec(entry().id, 'none'); await engine.validate(spec);
    const response = await app.inject({ method: 'GET', url: '/api/model-catalog', headers: { host: 'localhost:4318' } });
    assert.equal(response.statusCode, 200); assert.deepEqual(response.json(), getModelCatalog());
    const updated = getModelCatalog(); updated.models.find(m => m.id === entry().id)!.enabled = false; installModelCatalog(updated);
    assert.ok((await adapter.models()).every(m => m.id !== entry().id));
    await assert.rejects(engine.validate(spec), /사용할 수 없는 모델/);
    assert.equal(fixture.requests.length, 0);
  } finally { await app.close(); await engine.close(); store.close(); installModelCatalog(original); }
});
