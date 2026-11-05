import type { InvocationMetrics } from '../shared/types.js';
export function sourceUtteranceIds(call: InvocationMetrics): string[] {
  return [...new Set([...(call.sourceUtteranceId ? [call.sourceUtteranceId] : []),
    ...(Array.isArray(call.metadata.sourceUtteranceIds) ? call.metadata.sourceUtteranceIds.filter((id): id is string => typeof id === 'string') : [])])];
}
