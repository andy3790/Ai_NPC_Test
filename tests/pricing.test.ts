import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aggregateCost, estimateCost } from '../src/core/pricing.js';
import type { InvocationMetrics } from '../src/shared/types.js';

function invocation(overrides: Partial<InvocationMetrics> = {}): InvocationMetrics {
  return {
    model: 'gpt-6.1-terra', actualModel: null, metadata: { adapter: 'openai' },
    status: 'completed', startedAt: '2026-11-05T00:00:00Z', usageStatus: 'reported_response',
    usage: { inputTokens: 100, cachedInputTokens: 60, cacheWriteInputTokens: 10, outputTokens: 20, reasoningOutputTokens: 5, totalTokens: 120 },
    ...overrides,
  } as InvocationMetrics;
}

test('prices cache reads and writes once and uses the actual model for measured retries', () => {
  const terra = invocation();
  const luna = invocation({ actualModel: 'gpt-6-luna', status: 'failed', attempt: 2 });
  assert.equal(estimateCost(terra).usd, .0001455);
  assert.equal(estimateCost(luna).usd, .00001485);
  assert.ok(Math.abs(aggregateCost([terra, luna]).usd! - .00016035) < 1e-15);
});

test('long-context prices apply to the full request above the model threshold', () => {
  const usage = { ...invocation().usage, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 100 };
  assert.equal(estimateCost(invocation({ usage: { ...usage, inputTokens: 272_000 } })).usd, .2725);
  assert.equal(estimateCost(invocation({ usage: { ...usage, inputTokens: 272_001 } })).usd, .544752);
});

test('unknown rates and usage are visible while mock or pending calls add no cost', () => {
  const unknownModel = invocation({ actualModel: 'unknown-model' });
  const missing = invocation({ usage: { ...invocation().usage, inputTokens: null } });
  const assumed = invocation({ usage: { ...invocation().usage, cacheWriteInputTokens: null } });
  const mock = invocation({ metadata: { adapter: 'mock' } });
  assert.equal(estimateCost(unknownModel).status, 'missing_rate');
  assert.equal(estimateCost(missing).status, 'missing_usage');
  assert.equal(estimateCost({ ...missing, status: 'running' }).status, 'pending');
  assert.equal(estimateCost({ ...missing, startedAt: null }).status, 'not_applicable');
  assert.equal(estimateCost(assumed).status, 'assumed');
  assert.equal(estimateCost(mock).usd, null);
  const total = aggregateCost([unknownModel, missing, assumed, mock]);
  assert.equal(total.usd, .000143);
  assert.equal(total.unpricedCalls, 2);
  assert.equal(total.assumedCalls, 1);
  assert.equal(aggregateCost([unknownModel, mock]).usd, null);
});
