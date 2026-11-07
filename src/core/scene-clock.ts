import { randomUUID } from 'node:crypto';
import type { ExperimentSpec } from '../shared/schema.js';
import type { WorldState } from '../shared/world-schema.js';
import type { Utterance } from '../shared/types.js';
import { audienceNpcIds } from './perception.js';

export function nextClockBoundary(spec: ExperimentSpec, state: WorldState) {
  return Math.min(Infinity, ...(spec.scenario.clockEvents ?? []).filter(e => !state.firedClockEvents?.includes(e.id)).map(e => e.atSeconds),
    ...(spec.scenario.spatial?.connections ?? []).flatMap(c => c.closesAtSeconds !== undefined && c.closesAtSeconds > state.virtualSeconds ? [c.closesAtSeconds] : []));
}
// The caller atomically commits the new state, deliveries and public records.
export function clockObservations(spec: ExperimentSpec, state: WorldState, runId: string, sequence: number): Utterance[] {
  const records: Utterance[] = [];
  for (const e of [...(spec.scenario.clockEvents ?? [])].sort((a,b) => a.atSeconds - b.atSeconds)) {
    if (e.atSeconds > state.virtualSeconds || state.firedClockEvents?.includes(e.id)) continue;
    (state.firedClockEvents ??= []).push(e.id);
    const audience = { scope: e.locationIds ? 'locations' as const : 'all' as const, locationIds:e.locationIds ?? [], npcIds:[] };
    records.push({ id:randomUUID(), runId, sequence:++sequence, speechIndex:null, speakerId:'__environment__', speakerName:'현장',
      kind:'event', speech:e.text, action:'', createdAt:new Date().toISOString(), invocationId:null, deliveryCompletedAt:null, deliveryMs:null,
      worldEvent:{ type:'observation', text:e.text, sourceUtteranceId:null, virtualSeconds:e.atSeconds, npcId:null, processId:null, evidence:null, audience },
      ...(state.spatial && { perception:{ locationId:e.locationIds?.length === 1 ? e.locationIds[0] : null, virtualSeconds:e.atSeconds,
        speechRecipientIds:audienceNpcIds(spec,state,audience), actionRecipientIds:[], audience } }) });
  }
  return records;
}
