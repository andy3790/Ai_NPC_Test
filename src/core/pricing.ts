import type { CostSummary, InvocationMetrics } from '../shared/types.js';

import { getModelPricing, PRICING_DATE, PRICING_REVISION } from '../shared/model-catalog.js';
export { PRICING_DATE, PRICING_SOURCE, PRICING_REVISION } from '../shared/model-catalog.js';

type CostStatus = 'estimated' | 'assumed' | 'missing_rate' | 'missing_usage' | 'pending' | 'not_applicable';
interface InvocationCost { usd: number | null; status: CostStatus; model: string }

export function estimateCost(call: InvocationMetrics, adapter = call.metadata.adapter): InvocationCost {
  const model = call.actualModel || call.model;
  if (adapter === 'mock') return { usd: null, status: 'not_applicable', model };
  const usage = call.usage;
  const input = usage.inputTokens, output = usage.outputTokens;
  if (input == null || output == null) {
    if (['running', 'queued'].includes(call.status)) return { usd: null, status: 'pending', model };
    if (!call.startedAt) return { usd: null, status: 'not_applicable', model };
    return { usd: null, status: 'missing_usage', model };
  }
  const pricing = getModelPricing(model);
  if (!pricing) return { usd: null, status: 'missing_rate', model };
  const longContext = pricing.longContext !== undefined && input > pricing.longContext.aboveInputTokens;
  const rate = longContext ? pricing.longContext! : pricing;
  const cached = usage.cachedInputTokens ?? 0;
  const written = rate.write30m !== undefined ? usage.cacheWriteInputTokens ?? 0 : 0;
  const ordinary = input - cached - written;
  if (ordinary < 0 || cached < 0 || written < 0 || output < 0) return { usd: null, status: 'missing_usage', model };

  // API records are per response. A CLI turn can combine multiple requests,
  // so applying the per-request threshold to its aggregate is approximate.
  const inputCost = ordinary * rate.input + cached * rate.cached + written * (rate.write30m ?? 0);
  const usd = (inputCost + output * rate.output) / 1_000_000;
  const missingCacheBreakdown = input > 0 && (usage.cachedInputTokens == null || (rate.write30m !== undefined && usage.cacheWriteInputTokens == null));
  const assumed = missingCacheBreakdown || (longContext && call.usageStatus === 'reported_cumulative_delta');
  return { usd, status: assumed ? 'assumed' : 'estimated', model };
}

export function aggregateCost(calls: InvocationMetrics[], adapter?: string): CostSummary {
  let usd: number | null = null;
  let unpricedCalls = 0, assumedCalls = 0;
  for (const call of calls) {
    const cost = estimateCost(call, adapter);
    if (cost.usd !== null) usd = (usd ?? 0) + cost.usd;
    if (cost.status === 'missing_rate' || cost.status === 'missing_usage') unpricedCalls++;
    if (cost.status === 'assumed') assumedCalls++;
  }
  return { usd, unpricedCalls, assumedCalls, pricingDate: PRICING_DATE, pricingRevision: PRICING_REVISION };
}
