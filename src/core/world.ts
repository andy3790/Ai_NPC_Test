import { WORLD_PROMPT_VERSION, worldPolicies } from './world-policies.js';
export { WORLD_PROMPT_VERSION } from './world-policies.js';
import type { ExperimentSpec } from '../shared/schema.js';
import type { Utterance } from '../shared/types.js';
import { worldOutputSchema, type WorldOutput, type WorldState } from '../shared/world-schema.js';
import { z } from 'zod';
import { isSilentTurn } from './dialogue-idle.js';

export const initialWorldState = (): WorldState => ({ virtualSeconds: 0, facts: [], processes: [], processedSpeechId: null, processedSequence: 0, processedSpeechCount: 0 });

export const worldInstructions = worldPolicies[WORLD_PROMPT_VERSION].instructions;

// A quiet choice advances simulated time, independently of API latency.
// Opt in by the actual session revision; archived/custom sessions retain their contract.
export function worldResponseContract(version: string | null, source: Utterance) {
  const validator = version === 'npc-world/6' && isSilentTurn(source)
    ? worldOutputSchema.extend({ elapsedSeconds: z.literal(1).describe('무언·무동작 선택의 고정 가상 시간: 1초.') })
    : worldOutputSchema;
  return { validator, outputSchema: z.toJSONSchema(validator) };
}

// Receiving an opportunity is based on a committed NPC turn, never on an AI
// claim that another character reacted. New processes cannot clear this gate.
export function offerWorldReaction(state: WorldState, speakerId: string): WorldState {
  const next = structuredClone(state);
  for (const p of next.processes) if (p.status === 'pending' && p.waitingNpcIds.includes(speakerId)) {
    p.waitingNpcIds = p.waitingNpcIds.filter(id => id !== speakerId);
    if (!p.offeredNpcIds.includes(speakerId)) p.offeredNpcIds.push(speakerId);
  }
  return next;
}
export function priorityWorldSpeaker(state?: WorldState): string | null {
  return state?.processes.find(p => p.status === 'pending' && p.waitingNpcIds.length)?.waitingNpcIds[0] ?? null;
}

export function worldPrompt(spec: ExperimentSpec, state: WorldState, history: Utterance[], source: Utterance) {
  const publicData = (u: Utterance) => ({ id: u.id, sequence: u.sequence, speakerId: u.speakerId, speakerName: u.speakerName, kind: u.kind, speech: u.speech, action: u.action });
  return JSON.stringify({ task: 'environment', world: spec.scenario.world, situation: spec.scenario.situation,
    instructions: spec.scenario.worldEngineInstructions ?? '', npcs: spec.scenario.characters.map(c => ({ id: c.id, name: c.name })),
    state: { ...offerWorldReaction(state, source.speakerId), processes: offerWorldReaction(state, source.speakerId).processes.filter(p => p.status === 'pending') },
    publicChanges: history.filter(u => u.sequence > state.processedSequence && u.sequence <= source.sequence && u.id !== source.id && !u.worldEvent).map(publicData),
    currentAction: publicData(source),
  });
}

export function applyWorldOutput(state: WorldState, raw: unknown, source: Utterance, npcIds: string[]): { state: WorldState; output: WorldOutput } {
  const output = worldOutputSchema.parse(raw);
  const next = offerWorldReaction(state, source.speakerId);
  next.virtualSeconds += output.elapsedSeconds;
  if (!Number.isFinite(next.virtualSeconds)) throw new Error('세계 가상 시간 범위를 초과했습니다.');
  const fail = (message: string): never => { throw new Error(`세계 엔진 결과 오류: ${message}`); };
  const known = (id: string) => { if (!npcIds.includes(id)) fail(`알 수 없는 NPC ${id}`); };
  const unique = (ids: string[], name: string) => { if (new Set(ids).size !== ids.length) fail(`${name} ID 중복`); };
  unique(output.facts.map(f => f.id), '상태'); unique(output.forgetFactIds, '제거 상태');
  unique(output.processes.map(p => p.id), '사건'); unique(output.finishProcesses.map(p => p.id), '종료 사건');
  for (const update of output.processes) {
    unique(update.requestNpcIds, '반응 대상');
    const old = next.processes.find(p => p.id === update.id);
    if (old && old.status !== 'pending') fail(`종료된 사건 ID 재사용: ${update.id}`);
    for (const npcId of update.requestNpcIds) {
      known(npcId);
      if (npcId === source.speakerId || old?.offeredNpcIds.includes(npcId)) fail(`이미 발언한 NPC에게 같은 반응을 다시 요청: ${npcId}`);
    }
    if (old) {
      old.description = update.description; old.readyAtSeconds = update.readyAtSeconds;
      old.waitingNpcIds = [...new Set([...old.waitingNpcIds, ...update.requestNpcIds])];
    } else next.processes.push({ id: update.id, description: update.description, readyAtSeconds: update.readyAtSeconds, waitingNpcIds: [...update.requestNpcIds], offeredNpcIds: [], status: 'pending',
      createdAtSeconds: next.virtualSeconds, sourceUtteranceId: source.id, finishedAtSeconds: null, reason: null });
  }
  const blocked = new Set(next.processes.filter(p => p.status === 'pending').flatMap(p => p.waitingNpcIds));
  for (const finish of output.finishProcesses) {
    const process = next.processes.find(p => p.id === finish.id);
    if (!process || process.status !== 'pending') fail(`진행 중이 아닌 사건 종료: ${finish.id}`);
    if (process!.waitingNpcIds.length) fail(`NPC 반응 기회를 기다리는 사건: ${finish.id}`);
    if (finish.outcome === 'completed' && process!.readyAtSeconds > next.virtualSeconds) fail(`아직 시간이 되지 않은 사건: ${finish.id} (현재 ${next.virtualSeconds}초, 처리 가능 ${process!.readyAtSeconds}초). 사전 조치로 예정 사건이 불필요해졌다면 cancelled로 해소하세요. 실제 행동과 무관하게 시간을 앞당기지 마세요.`);
    Object.assign(process!, { status: finish.outcome, reason: finish.reason, finishedAtSeconds: next.virtualSeconds });
  }
  for (const event of output.events) {
    if (event.npcId) known(event.npcId);
    if (event.processId && !next.processes.some(p => p.id === event.processId)) fail(`알 수 없는 사건 결과: ${event.processId}`);
    if (event.type === 'actor_result') {
      if (event.npcId !== source.speakerId || !event.evidence || !(source.action.includes(event.evidence) || source.speech.includes(event.evidence))) fail('자발적 행동 결과는 현재 화자의 선택을 정확히 인용해야 합니다.');
    } else if (event.type === 'physical_effect') {
      if (!event.npcId) fail('신체적 결과의 대상 NPC가 필요합니다.');
      if (blocked.has(event.npcId!)) fail('반응 기회 전에 대상 NPC의 물리적 결과를 확정할 수 없습니다.');
    } else if (event.npcId !== null) fail('NPC의 행동·물리 결과는 전용 유형으로 기록하세요.');
  }
  for (const id of output.forgetFactIds) {
    if (output.facts.some(f => f.id === id)) fail(`동시에 제거·변경하는 상태: ${id}`);
    if (!next.facts.some(f => f.id === id)) fail(`존재하지 않는 상태 제거: ${id}`);
  }
  next.facts = next.facts.filter(f => !output.forgetFactIds.includes(f.id));
  for (const fact of output.facts) {
    if (fact.scope === 'npc_physical') {
      if (!fact.npcId) fail('NPC 물리 상태의 대상이 필요합니다.');
      known(fact.npcId!);
      if (!output.events.some(e => e.npcId === fact.npcId && ['physical_effect', 'actor_result'].includes(e.type)))
        fail(`NPC 물리 상태는 해당 공개 결과와 함께 기록해야 합니다. ${fact.npcId}의 ${fact.id}에 근거가 없습니다. 이번 화자가 물건을 내밀어도 상대방이 받았다는 선택은 상대방 차례에 확인하세요.`);
    } else if (fact.npcId !== null) fail('환경 상태에 NPC를 지정할 수 없습니다.');
    next.facts = [...next.facts.filter(f => f.id !== fact.id), fact];
  }
  next.processedSpeechId = source.id; next.processedSequence = source.sequence; next.processedSpeechCount = source.speechIndex!;
  return { state: next, output };
}
