import type { ExperimentSpec } from '../shared/schema.js';
import { spatialPlanSchema, spatialResolutionSchema, type SpatialSpeech, type SpatialPosition, type SituationProposal } from '../shared/spatial-schema.js';
import type { WorldState } from '../shared/world-schema.js';
import type { Utterance } from '../shared/types.js';
import { initialWorldState } from './world.js';
import { audienceNpcIds, contactPossible, inSightAndSound, positionKey, speechPerception } from './perception.js';

export function initialSpatialWorld(spec: ExperimentSpec): WorldState {
  return { ...initialWorldState(), spatial: { positions: spec.scenario.characters.map(c => ({ ...spec.scenario.spatial!.initialPositions.find(p => p.npcId === c.id)!, transit: null })),
    activities: [], cycle: null, nextCycle: 1, lastSelectedNpcIds: [], pendingResolution: null, nextResolution: 1 } };
}
const pending = (s: WorldState) => s.spatial!.activities.filter(a => a.status === 'pending');
export function reactionCandidates(state: WorldState) {
  return [...new Set([...pending(state).flatMap(a => a.waitingNpcIds), ...state.processes.filter(p => p.status === 'pending').flatMap(p => p.waitingNpcIds)])];
}
export function selectableGroups(spec: ExperimentSpec, state: WorldState, history: Utterance[]) {
  const groups = new Map<string, string[]>(); const urgent = reactionCandidates(state);
  const positions = state.spatial!.positions;
  // Shared doorways form a single speaking group even in a chain of rooms.
  // What a listener actually perceives remains a direct line of sight/sound.
  const groupFor = new Map<string,string>();
  for (const start of positions) {
    if (groupFor.has(start.npcId)) continue;
    const key = positionKey(start), members = [start]; groupFor.set(start.npcId,key);
    for (const member of members) for (const other of positions) {
      if (groupFor.has(other.npcId) || !inSightAndSound(spec,state.virtualSeconds,member,other)) continue;
      groupFor.set(other.npcId,key); members.push(other);
    }
  }
  for (const pos of positions) {
    const same = positions.filter(p => inSightAndSound(spec,state.virtualSeconds,p,pos));
    const key = groupFor.get(pos.npcId)!; const sameSpace = same.map(p => p.npcId);
    const speaking = state.spatial!.activities.some(a => sameSpace.includes(a.npcId) && a.speakingUntilSeconds > state.virtualSeconds);
    const busy = pending(state).some(a => a.npcId === pos.npcId);
    if (speaking || (busy && !urgent.includes(pos.npcId))) continue;
    const list = groups.get(key) ?? []; list.push(pos.npcId); groups.set(key, list);
  }
  const last = (id: string) => history.findLastIndex(u => u.kind === 'speech' && u.speakerId === id);
  return [...groups.entries()].map(([key, ids]) => ({ key, ids: ids.some(id => urgent.includes(id)) ? ids.filter(id => urgent.includes(id)).sort((a, b) => urgent.indexOf(a) - urgent.indexOf(b)) : ids.sort((a, b) => last(a) - last(b)), urgent: ids.some(id => urgent.includes(id)) }))
    .sort((a, b) => Number(b.urgent) - Number(a.urgent) || last(a.ids[0]) - last(b.ids[0]));
}
export function connectionFor(spec: ExperimentSpec, pos: SpatialPosition, destination: string, at = 0) {
  const map = spec.scenario.spatial!;
  const routes = map.connections.filter(c => at < (c.closesAtSeconds ?? Infinity));
  if (pos.transit) return [pos.transit.from, pos.transit.to].includes(destination) ? routes.find(c => c.id === pos.transit!.connectionId) : undefined;
  return routes.find(c => c.from === pos.locationId && c.to === destination || c.bidirectional && c.to === pos.locationId && c.from === destination);
}
export function closePassages(spec: ExperimentSpec, state: WorldState) {
  if (!spec.scenario.spatial!.connections.some(r => state.virtualSeconds >= (r.closesAtSeconds ?? Infinity))) return;
  for (const p of state.spatial!.positions) {
    const t = p.transit;
    if (!t || !spec.scenario.spatial!.connections.some(r => r.id === t.connectionId && state.virtualSeconds >= (r.closesAtSeconds ?? Infinity))) continue;
    for (const a of state.spatial!.activities) if (a.npcId === p.npcId && a.status === 'pending') {
      a.status = 'failed'; a.reason = '도착 전 통로 폐쇄'; a.finishedAtSeconds = state.virtualSeconds; a.waitingNpcIds = [];
    }
    p.locationId = t.from; p.transit = null;
    for (const f of state.facts) if (f.scope === 'npc_physical' && f.npcId === p.npcId) f.locationId = p.locationId;
  }
  for (const a of state.spatial!.activities) if (a.status === 'pending' && a.waitingNpcIds.length)
    a.waitingNpcIds = a.waitingNpcIds.filter(id => contactPossible(spec,state,a.npcId,id));
}
export function validateSpatialChoice(spec: ExperimentSpec, state: WorldState, npcId: string, output: SpatialSpeech) {
  const main = pending(state).find(a => a.npcId === npcId && a.kind === 'action');
  if (main ? output.activityChoice === 'start' : output.activityChoice !== 'start') throw new Error(main ? '진행 중인 행동의 계속·중단을 선택하세요.' : '진행 중인 행동이 없으므로 start를 선택하세요.');
  if (output.moveToLocationId) {
    if (output.activityChoice === 'continue') throw new Error('이동 변경은 기존 행동 중단 후 새 행동으로 요청하세요.');
    const pos = state.spatial!.positions.find(p => p.npcId === npcId)!;
    if (!connectionFor(spec, pos, output.moveToLocationId, state.virtualSeconds)) throw new Error('현재 위치와 열린 통로로 연결되지 않은 목적지입니다.');
  }
  return speechPerception(spec, state, npcId, output);
}
export function commitSpatialChoice(state: WorldState, u: Utterance): WorldState {
  const next = structuredClone(state); const now = next.virtualSeconds;
  for (const a of [...next.spatial!.activities, ...next.processes]) if (a.status === 'pending' && a.waitingNpcIds.includes(u.speakerId)) {
    a.waitingNpcIds = a.waitingNpcIds.filter(id => id !== u.speakerId);
    if (!a.offeredNpcIds.includes(u.speakerId)) a.offeredNpcIds.push(u.speakerId);
  }
  if (u.spatialIntent!.activityChoice === 'cancel') for (const a of next.spatial!.activities) if (a.npcId === u.speakerId && a.kind === 'action' && a.status === 'pending') {
    a.status = 'cancelled'; a.reason = 'NPC가 중단을 선택함'; a.finishedAtSeconds = now;
  }
  return next;
}

export function applySpatialPlan(spec: ExperimentSpec, state: WorldState, choices: Utterance[], raw: unknown): WorldState {
  const out = spatialPlanSchema.parse(raw); const next = structuredClone(state); const s = next.spatial!;
  if (out.plans.length !== choices.length || new Set(out.plans.map(p => p.utteranceId)).size !== choices.length) throw new Error('선택마다 시간 계획이 정확히 하나씩 필요합니다.');
  for (const plan of out.plans) {
    const u = choices.find(u => u.id === plan.utteranceId); if (!u) throw new Error('다른 차례의 시간 계획입니다.');
    const output = u.spatialIntent!, pos = s.positions.find(p => p.npcId === u.speakerId)!;
    const ready = next.virtualSeconds + Math.max(plan.speechSeconds, plan.actionSeconds);
    if (!Number.isFinite(ready)) throw new Error('가상 시간 범위를 초과했습니다.');
    if (!u.speech.trim() && plan.speechSeconds !== 0) throw new Error('무발언 행동의 말하기 시간은 0이어야 합니다.');
    const informed = new Set([...(u.perception?.speechRecipientIds ?? []), ...(u.perception?.actionRecipientIds ?? [])]);
    if (new Set(plan.reactionNpcIds).size !== plan.reactionNpcIds.length || plan.reactionNpcIds.some(id => !informed.has(id))) throw new Error('반응 요청은 실제로 행동·대화를 관찰한 대상에게만 가능합니다.');
    if (plan.movementStarts && !output.moveToLocationId) throw new Error('NPC가 요청하지 않은 이동입니다.');
    const kind = output.activityChoice === 'continue' ? 'reaction' : 'action';
    s.activities.push({ id: u.id, sourceUtteranceId: u.id, npcId: u.speakerId, kind, status: 'pending', reason: null,
      startedAtSeconds: next.virtualSeconds, readyAtSeconds: ready, speakingUntilSeconds: next.virtualSeconds + plan.speechSeconds,
      finishedAtSeconds: null, locationId: pos.locationId, moveToLocationId: output.moveToLocationId,
      waitingNpcIds: [...plan.reactionNpcIds], offeredNpcIds: [] });
    if (plan.movementStarts) {
      const route = connectionFor(spec, pos, output.moveToLocationId!, next.virtualSeconds); if (!route) throw new Error('이동을 시작할 통로가 없습니다.');
      pos.transit = { from: pos.transit?.from ?? pos.locationId!, to: pos.transit?.to ?? output.moveToLocationId!, connectionId: route.id, activityId: u.id };
      pos.locationId = null;
    }
  }
  s.cycle = null;
  next.processedSpeechCount += choices.length; next.processedSpeechId = choices.at(-1)?.id ?? next.processedSpeechId;
  next.processedSequence = choices.at(-1)?.sequence ?? next.processedSequence;
  return next;
}

export function dueActivities(state: WorldState) { return pending(state).filter(a => a.readyAtSeconds <= state.virtualSeconds && !a.waitingNpcIds.length); }
export function dueProcesses(state: WorldState) { return state.processes.filter(p => p.status === 'pending' && p.readyAtSeconds <= state.virtualSeconds && !p.waitingNpcIds.length); }
export function nextSpatialTime(state: WorldState, nextEventCheck = Infinity): number | null {
  const times = [...pending(state).filter(a => !a.waitingNpcIds.length).map(a => a.readyAtSeconds),
    ...state.processes.filter(p => p.status === 'pending' && !p.waitingNpcIds.length).map(p => p.readyAtSeconds),
    ...state.spatial!.activities.map(a => a.speakingUntilSeconds), nextEventCheck].filter(t => Number.isFinite(t) && t > state.virtualSeconds);
  return times.length ? Math.min(...times) : null;
}

export function applySpatialResolution(spec: ExperimentSpec, state: WorldState, history: Utterance[], raw: unknown, proposal?: SituationProposal) {
  const out = spatialResolutionSchema.parse(raw), next = structuredClone(state), s = next.spatial!, time = next.virtualSeconds;
  const npcIds = spec.scenario.characters.map(c => c.id), locIds = spec.scenario.spatial!.locations.map(l => l.id);
  const fail = (message: string): never => { throw new Error(`분산 세계 결과 오류: ${message}`); };
  const knownNpcs = (ids: string[]) => { if (new Set(ids).size !== ids.length || ids.some(id => !npcIds.includes(id))) fail('알 수 없거나 중복된 NPC'); };
  const unique = (ids: string[]) => { if (new Set(ids).size !== ids.length) fail('변경 ID 중복'); };
  for (const ids of [out.completedActivities.map(a => a.id), out.activityUpdates.map(a => a.id), out.movements.map(m => m.npcId), out.facts.map(f => f.id), out.forgetFactIds, out.processes.map(p => p.id), out.finishProcesses.map(p => p.id)]) unique(ids);
  if (!!proposal !== !!out.proposalDecision) fail('상황 제안의 검토 결과 누락 또는 불필요한 판정');
  if (proposal && out.events.some(e => e.proposalId !== null && e.proposalId !== proposal.id)) fail('다른 상황 제안의 결과');
  if (!proposal && out.events.some(e => e.proposalId !== null)) fail('존재하지 않는 상황 제안');
  if (proposal && !out.proposalDecision!.accepted && out.events.some(e => e.proposalId === proposal.id)) fail('거절한 상황을 공개할 수 없습니다.');
  if (proposal && !out.proposalDecision!.accepted && [out.events, out.facts, out.forgetFactIds, out.movements, out.completedActivities, out.activityUpdates, out.processes, out.finishProcesses].some(a => a.length)) fail('거절한 상황은 세계 상태를 변경할 수 없습니다.');
  if (proposal && out.proposalDecision!.accepted && ![out.events, out.facts, out.processes, out.completedActivities, out.movements, out.activityUpdates].some(a => a.length)) fail('채택한 상황의 실제 반영 내용이 없습니다.');
  for (const update of out.activityUpdates) {
    const a = s.activities.find(a => a.id === update.id && a.status === 'pending');
    if (!a || out.completedActivities.some(c => c.id === update.id)) fail('진행 중 행동만 갱신할 수 있습니다.');
    knownNpcs(update.requestNpcIds);
    if (update.requestNpcIds.some(id => !contactPossible(spec,state,a!.npcId,id)))
      fail('닫힌 공간 사이에는 이 행동의 반응을 요청할 경로가 없습니다. 현재 장소에서 가능한 결과를 처리하세요.');
    if (update.requestNpcIds.some(id => a!.offeredNpcIds.includes(id))) fail('동일 행동에서 이미 제공한 반응 기회');
    a!.waitingNpcIds = [...new Set([...a!.waitingNpcIds, ...update.requestNpcIds])];
    if (update.readyAtSeconds < time || update.readyAtSeconds === time && !a!.waitingNpcIds.length) fail('계속될 행동은 미래 시각이나 반응 조건이 필요합니다.');
    a!.readyAtSeconds = update.readyAtSeconds;
  }
  for (const p of out.processes) {
    if (p.locationIds.some(id => !locIds.includes(id))) fail('정의되지 않은 사건 장소');
    knownNpcs(p.requestNpcIds);
    const old = next.processes.find(x => x.id === p.id);
    if (old && old.status !== 'pending') fail('종료 사건 ID 재사용');
    if (p.requestNpcIds.some(id => old?.offeredNpcIds.includes(id))) fail('동일 사건의 반응을 반복 요청');
    if (old) Object.assign(old, { description: p.description, readyAtSeconds: p.readyAtSeconds, locationIds: p.locationIds, waitingNpcIds: [...new Set([...old.waitingNpcIds, ...p.requestNpcIds])] });
    else next.processes.push({ id: p.id, description: p.description, readyAtSeconds: p.readyAtSeconds, locationIds: p.locationIds,
      createdAtSeconds: time, sourceUtteranceId: proposal?.id ?? history.findLast(u => u.kind === 'speech')?.id ?? 'system',
      waitingNpcIds: [...p.requestNpcIds], offeredNpcIds: [], status: 'pending', finishedAtSeconds: null, reason: null });
  }
  const blocked = new Set(reactionCandidates(next));
  for (const c of out.completedActivities) {
    const a = s.activities.find(a => a.id === c.id);
    if (!a || a.status !== 'pending' || a.waitingNpcIds.length || c.outcome === 'completed' && a.readyAtSeconds > time) fail('아직 완료할 수 없는 행동');
    Object.assign(a!, { status: c.outcome, finishedAtSeconds: time, reason: c.reason });
  }
  for (const a of dueActivities(state)) if (!out.completedActivities.some(c => c.id === a.id) && !out.activityUpdates.some(u => u.id === a.id)) fail('처리 시각에 도달한 행동 결과가 빠졌습니다.');
  for (const f of out.finishProcesses) {
    const p = next.processes.find(p => p.id === f.id);
    if (!p || p.status !== 'pending' || p.waitingNpcIds.length || f.outcome === 'completed' && p.readyAtSeconds > time) fail('아직 종료할 수 없는 사건');
    Object.assign(p!, { status: f.outcome, finishedAtSeconds: time, reason: f.reason });
  }
  for (const p of next.processes) if (p.status === 'pending' && p.readyAtSeconds <= time && !p.waitingNpcIds.length) fail('시각이 도래한 사건은 종료하거나 미래로 재예약해야 합니다.');
  for (const e of out.events) {
    const recipients = audienceNpcIds(spec, next, e.audience);
    if (e.npcId && !npcIds.includes(e.npcId)) fail('알 수 없는 사건 대상');
    if (e.processId && !next.processes.some(p => p.id === e.processId)) fail('알 수 없는 사건 ID');
    if (e.type === 'actor_result') {
      const source = history.find(u => u.id === e.sourceUtteranceId);
      const finished = s.activities.find(a => a.sourceUtteranceId === e.sourceUtteranceId && out.completedActivities.some(c => c.id === a.id));
      if (!source || !finished || e.npcId !== source.speakerId || !e.evidence || !(source.action.includes(e.evidence) || source.speech.includes(e.evidence))) fail('본인이 선택하고 이번에 처리한 행동만 결과로 확정할 수 있습니다.');
    } else if (e.type === 'physical_effect') {
      if (!e.npcId || blocked.has(e.npcId) || !recipients.includes(e.npcId)) fail('반응 기회·수신 대상이 보장되지 않은 물리 결과');
    } else if (e.npcId !== null) fail('NPC 결과는 전용 유형으로 기록하세요.');
  }
  const requested = [...out.activityUpdates.flatMap(u => u.requestNpcIds), ...out.processes.flatMap(p => p.requestNpcIds)];
  for (const id of requested) if (!out.events.some(e => audienceNpcIds(spec, next, e.audience).includes(id))) fail('새 반응 요청에는 해당 NPC가 관찰할 사건이 필요합니다.');
  for (const m of out.movements) {
    const pos = s.positions.find(p => p.npcId === m.npcId); if (!pos || !locIds.includes(m.toLocationId)) fail('알 수 없는 이동 대상·목적지');
    if (m.kind === 'requested') {
      const a = s.activities.find(a => a.id === m.activityId && a.npcId === m.npcId);
      if (!a || a.moveToLocationId !== m.toLocationId || a.status !== 'completed' || !out.completedActivities.some(c => c.id === a.id) || pos!.transit?.activityId !== a.id) fail('NPC가 요청하고 실제로 완료한 이동이 아닙니다.');
    } else {
      if (m.activityId !== null || blocked.has(m.npcId) || !connectionFor(spec, pos!, m.toLocationId,time) || !out.events.some(e => e.type === 'physical_effect' && e.npcId === m.npcId)) fail('비자발적 이동에는 연결된 장소·반응 기회·물리 결과가 필요합니다.');
      for (const a of s.activities) if (a.npcId === m.npcId && a.status === 'pending' && a.kind === 'action') Object.assign(a, { status: 'failed', finishedAtSeconds: time, reason: '비자발적 위치 변경으로 기존 장소의 행동이 불가능해짐' });
    }
    pos!.locationId = m.toLocationId; pos!.transit = null;
    for (const fact of next.facts) if (fact.scope === 'npc_physical' && fact.npcId === m.npcId) fact.locationId = m.toLocationId;
  }
  for (const a of s.activities) if (a.status === 'completed' && out.completedActivities.some(c => c.id === a.id) && state.spatial!.positions.some(p => p.transit?.activityId === a.id) && !out.movements.some(m => m.activityId === a.id)) fail('완료된 이동의 도착 위치가 빠졌습니다.');
  for (const id of out.forgetFactIds) if (!next.facts.some(f => f.id === id) || out.facts.some(f => f.id === id)) fail('동시에 제거·변경하거나 존재하지 않는 상태');
  next.facts = next.facts.filter(f => !out.forgetFactIds.includes(f.id));
  for (const f of out.facts) {
    if (f.locationId !== null && !locIds.includes(f.locationId)) fail('알 수 없는 상태 장소');
    if (f.scope === 'npc_physical') {
      if (!f.npcId || !npcIds.includes(f.npcId) || !out.events.some(e => e.npcId === f.npcId && ['physical_effect', 'actor_result'].includes(e.type))) fail('NPC 물리 상태에는 해당 결과가 필요합니다.');
    } else if (f.npcId !== null) fail('환경 상태에 NPC 지정');
    next.facts = [...next.facts.filter(x => x.id !== f.id), f];
  }
  s.pendingResolution = null;
  return { state: next, output: out };
}
