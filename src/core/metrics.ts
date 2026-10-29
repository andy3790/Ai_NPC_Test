import type { InvocationMetrics, TokenUsage } from '../shared/types.js';
export const tokenKeys = ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'] as const;
export const emptyUsage = (): TokenUsage => Object.fromEntries(tokenKeys.map(k => [k, null])) as unknown as TokenUsage;
export function normalizeUsage(value: any): TokenUsage {
  return Object.fromEntries(tokenKeys.map(k => [k, Number.isSafeInteger(value?.[k]) && value[k] >= 0 ? value[k] : null])) as unknown as TokenUsage;
}
// The protocol's `last` is the last model request, NOT necessarily the entire turn.
// Use thread total deltas to account for multiple requests and compaction in one turn.
export class UsageTracker {
  baseline: TokenUsage | null; latest: TokenUsage | null = null; invalid = false;
  constructor(baseline: TokenUsage | null) { this.baseline = baseline; }
  update(event: any) {
    const total = normalizeUsage(event?.tokenUsage?.total ?? event?.total);
    if (total.totalTokens === null) return;
    const before = this.latest ?? this.baseline;
    if (before && tokenKeys.some(k => total[k] !== null && before[k] !== null && total[k]! < before[k]!)) this.invalid = true;
    this.latest = total;
  }
  result(): { usage: TokenUsage; status: string } {
    if (!this.latest) return { usage: emptyUsage(), status: 'missing_usage_event' };
    if (!this.baseline || this.invalid) return { usage: emptyUsage(), status: this.invalid ? 'counter_discontinuity' : 'unknown_baseline' };
    return { usage: Object.fromEntries(tokenKeys.map(k => [k, this.latest![k] === null || this.baseline![k] === null ? null : this.latest![k]! - this.baseline![k]!])) as unknown as TokenUsage, status: 'reported_cumulative_delta' };
  }
}
export function aggregate(calls: InvocationMetrics[]) {
  const durations = calls.filter(x => x.status === 'completed' && x.durationMs !== null).map(x => x.durationMs!).sort((a, b) => a - b);
  const quantile = (q: number) => durations.length ? durations[Math.max(0, Math.ceil(durations.length * q) - 1)] : null;
  return { calls: calls.length, failed: calls.filter(x => ['failed', 'cancelled', 'uncertain'].includes(x.status)).length,
    pendingCalls: calls.filter(x => ['running', 'queued'].includes(x.status)).length,
    missingUsage: calls.filter(x => !['running', 'queued'].includes(x.status) && x.usage.totalTokens === null).length,
    tokens: Object.fromEntries(tokenKeys.map(k => [k, !calls.length ? 0 : calls.some(x => x.usage[k] !== null) ? calls.reduce((s, x) => s + (x.usage[k] ?? 0), 0) : null])),
    durationSumMs: calls.reduce((s, x) => s + (x.durationMs ?? 0), 0), medianMs: quantile(.5), p95Ms: quantile(.95),
    failureRate: calls.length ? calls.filter(x => ['failed', 'cancelled', 'uncertain'].includes(x.status)).length / calls.length : null,
  };
}
export function groupedMetrics(calls: InvocationMetrics[]) {
  const groups = new Map<string, InvocationMetrics[]>();
  for (const c of calls) { const key = JSON.stringify([c.metadata.adapter ?? 'unknown', c.model, c.effort, c.deliveryMode, c.memoryMode, c.kind]); const group = groups.get(key) ?? []; group.push(c); groups.set(key, group); }
  return [...groups.values()].map(group => {
    const summary = aggregate(group);
    return { adapter: String(group[0].metadata.adapter ?? 'unknown'), model: group[0].model, effort: group[0].effort, deliveryMode: group[0].deliveryMode, memoryMode: group[0].memoryMode, kind: group[0].kind, runs: new Set(group.map(c => c.runId)).size, tokensPerCall: summary.tokens.totalTokens === null ? null : summary.tokens.totalTokens / group.length, ...summary };
  });
}
