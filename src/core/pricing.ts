import type { CostSummary, InvocationMetrics } from '../shared/types.js';

export const PRICING_DATE = '2026-11-05';
export const PRICING_SOURCE = 'https://developers.openai.com/api/docs/pricing';

interface StandardRate {
  input: number;
  cached: number;
  output: number;
  write30m?: number;
  longContextThreshold?: number;
}

// USD per million text tokens, Standard processing. Sources for older entries
// are their official API model pages. Add verified snapshot IDs explicitly.
const rates: Record<string, StandardRate> = {
  'gpt-6-astra': { input: 10, cached: 1, output: 50, write30m: 12.5, longContextThreshold: 272_000 },
  'gpt-6.1-sol': { input: 2, cached: .10, output: 10, write30m: 2.5, longContextThreshold: 272_000 },
  'gpt-6.1-terra': { input: 1, cached: .05, output: 5, write30m: 1.25, longContextThreshold: 272_000 },
  'gpt-6-sol': { input: 2, cached: .20, output: 10, write30m: 2.5, longContextThreshold: 272_000 },
  'gpt-6-luna': { input: .10, cached: .01, output: .50, write30m: .125, longContextThreshold: 272_000 },
  'gpt-5.3-codex': { input: 1.75, cached: .175, output: 14 },
  'gpt-4.1-mini': { input: .40, cached: .10, output: 1.60 },
};
rates['gpt-4.1-mini-2025-04-14'] = rates['gpt-4.1-mini'];

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
  if (!Object.hasOwn(rates, model)) return { usd: null, status: 'missing_rate', model };
  const rate = rates[model];
  const cached = usage.cachedInputTokens ?? 0;
  const written = rate.write30m ? usage.cacheWriteInputTokens ?? 0 : 0;
  const ordinary = input - cached - written;
  if (ordinary < 0 || cached < 0 || written < 0 || output < 0) return { usd: null, status: 'missing_usage', model };

  // API records are per response. A CLI turn can combine multiple requests,
  // so applying the per-request threshold to its aggregate is approximate.
  const longContext = rate.longContextThreshold !== undefined && input > rate.longContextThreshold;
  const inputCost = ordinary * rate.input + cached * rate.cached + written * (rate.write30m ?? 0);
  const usd = (inputCost * (longContext ? 2 : 1) + output * rate.output * (longContext ? 1.5 : 1)) / 1_000_000;
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
  return { usd, unpricedCalls, assumedCalls, pricingDate: PRICING_DATE };
}
