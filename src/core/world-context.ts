import type { Utterance } from '../shared/types.js';
import type { SpatialActivity } from '../shared/spatial-schema.js';
import type { WorldState } from '../shared/world-schema.js';

// /1 chained every model response. /2 reconstructs each ruling from committed state.
export const WORLD_CONTEXT_VERSION = 'world-context/2' as const;

function worldChoice(u: Utterance) {
  const intent = u.spatialIntent;
  return { id: u.id, sequence: u.sequence, speakerId: u.speakerId, speakerName: u.speakerName,
    speech: u.speech, action: u.action, perception: u.perception,
    ...(intent && { communication: intent.communication, moveToLocationId: intent.moveToLocationId, activityChoice: intent.activityChoice }) };
}

export function worldRequestContext(input: string, state: WorldState | undefined, history: Utterance[], failure?: string | null) {
  const { world, situation, worldEngineInstructions, instructions, spatial, npcs, ...tick } = JSON.parse(input);
  const scene = { world, situation, worldEngineInstructions, instructions, spatial, npcs,
    contextRule: '시작 장면은 과거의 출발점이다. 이번 판정은 현재 상태와 실제 선택을 기준으로 한다. 종료·취소된 사건은 다시 시작하지 않는다.' };
  if (tick.choices) tick.choices = tick.choices.map(worldChoice);
  if (tick.current?.activities) {
    tick.current.activities = tick.current.activities.map(({ choice, ...activity }: SpatialActivity & { choice?: Utterance }) =>
      ({ ...activity, ...(choice && { choice: worldChoice(choice) }) }));
  }
  if (tick.changes) tick.changes = tick.changes.map(({ knownUtteranceIds, ...change }: { knownUtteranceIds?: string[] }) => change);
  // Pending work, deadlines, positions, facts and source actions remain complete in tick.
  // A fresh request also needs to know which one-shot events have already settled.
  tick.closedProcesses = (state?.processes ?? []).filter(p => p.status !== 'pending')
    .map(({ id, status, finishedAtSeconds, reason }) => ({ id, status, finishedAtSeconds, reason }));
  const included = new Set((tick.changes ?? []).map((u: { id: string }) => u.id));
  const recent = [];
  for (let i = history.length - 1; i >= 0 && recent.length < 6; i--) {
    const u = history[i], event = u.worldEvent;
    if (event && !included.has(u.id)) recent.push({ sequence: u.sequence, type: event.type, text: u.speech,
      at: event.virtualSeconds, npcId: event.npcId, audience: event.audience });
  }
  tick.recentResults = recent.reverse();
  if (failure) tick.previousFailure = failure.slice(0, 5000);
  return { scene, tick };
}
