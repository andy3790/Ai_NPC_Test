import type { ExperimentSpec } from '../shared/schema.js';
import type { Audience, SpatialPosition, SpatialSpeech } from '../shared/spatial-schema.js';
import type { WorldState } from '../shared/world-schema.js';
import type { Utterance } from '../shared/types.js';

export const positionKey = (p: SpatialPosition) => p.locationId ?? `transit:${p.transit?.connectionId ?? p.npcId}`;
export function inSightAndSound(spec: ExperimentSpec, time: number, a: SpatialPosition, b: SpatialPosition) {
  if (positionKey(a) === positionKey(b)) return true;
  return spec.scenario.spatial!.connections.some(route => route.sightAndSound && time < (route.closesAtSeconds ?? Infinity) &&
    [a,b].every(p => p.locationId ? p.locationId === route.from || p.locationId === route.to : p.transit?.connectionId === route.id));
}
export function contactPossible(spec: ExperimentSpec, state: WorldState, from: string, to: string) {
  if (from === to) return true;
  const space = spec.scenario.spatial!, positions = state.spatial!.positions;
  if (space.channels.some(c => c.memberNpcIds.includes(from) && c.memberNpcIds.includes(to))) return true;
  const endpoints = (p: SpatialPosition) => p.locationId ? [p.locationId] : p.transit ? [p.transit.from,p.transit.to] : [];
  const origin = positions.find(p => p.npcId === from), target = positions.find(p => p.npcId === to);
  if (!origin || !target) return false;
  const reachable = new Set(endpoints(origin));
  // Physical effects may propagate along a one-way walking route in either
  // direction. Only a fully severed component rules out a requested response.
  for (const node of reachable) for (const link of space.connections) {
    if (state.virtualSeconds >= (link.closesAtSeconds ?? Infinity)) continue;
    if (link.from === node) reachable.add(link.to);
    if (link.to === node) reachable.add(link.from);
  }
  return endpoints(target).some(id => reachable.has(id));
}
export function audienceNpcIds(spec: ExperimentSpec, state: WorldState | undefined, audience: Audience): string[] {
  const ids = spec.scenario.characters.map(c => c.id), locations = spec.scenario.spatial?.locations.map(p => p.id) ?? [];
  if (new Set(audience.npcIds).size !== audience.npcIds.length || new Set(audience.locationIds).size !== audience.locationIds.length ||
      audience.npcIds.some(id => !ids.includes(id)) || audience.locationIds.some(id => !locations.includes(id))) throw new Error('알 수 없거나 중복된 상황 수신 대상입니다.');
  if (audience.scope === 'all' || audience.scope === 'none') {
    if (audience.npcIds.length || audience.locationIds.length) throw new Error('전체·비공개 범위에는 개별 대상을 지정할 수 없습니다.');
    return audience.scope === 'all' ? ids : [];
  }
  if (audience.scope === 'npcs') {
    if (!audience.npcIds.length || audience.locationIds.length) throw new Error('NPC 수신 범위에 NPC만 지정하세요.');
    return [...audience.npcIds];
  }
  if (!audience.locationIds.length || audience.npcIds.length) throw new Error('장소 수신 범위에 장소만 지정하세요.');
  return state?.spatial?.positions.filter(p => p.locationId ? audience.locationIds.includes(p.locationId)
    : p.transit && [p.transit.from,p.transit.to].every(id => audience.locationIds.includes(id))).map(p => p.npcId) ??
    spec.scenario.spatial?.initialPositions.filter(p => audience.locationIds.includes(p.locationId)).map(p => p.npcId) ?? [];
}

export function speechPerception(spec: ExperimentSpec, state: WorldState, npcId: string, output: SpatialSpeech): NonNullable<Utterance['perception']> {
  const spatial = state.spatial!; const position = spatial.positions.find(p => p.npcId === npcId)!;
  const neighbours = spatial.positions.filter(p => p.npcId !== npcId && inSightAndSound(spec,state.virtualSeconds,p,position)).map(p => p.npcId);
  const comm = output.communication; let speechRecipients: string[] = [];
  if (new Set(comm.targetNpcIds).size !== comm.targetNpcIds.length || comm.targetNpcIds.includes(npcId)) throw new Error('대화 대상은 본인을 제외하고 중복 없이 지정하세요.');
  if (comm.mode !== 'channel' && comm.channelId !== null) throw new Error('통신 채널 모드에서만 channelId를 지정하세요.');
  if (comm.mode === 'local') {
    if (comm.targetNpcIds.some(id => !neighbours.includes(id))) throw new Error('일반 대화의 상대가 현재 보고 들을 수 있는 곳에 없습니다.');
    speechRecipients = neighbours;
  } else if (comm.mode === 'whisper') {
    if (!comm.targetNpcIds.length || comm.targetNpcIds.some(id => !neighbours.includes(id) || !spatial.positions.some(p => p.npcId === id && positionKey(p) === positionKey(position)))) throw new Error('귓속말은 현재 같은 공간에 있는 NPC에게만 보낼 수 있습니다.');
    speechRecipients = comm.targetNpcIds;
  } else if (comm.mode === 'channel') {
    const channel = spec.scenario.spatial!.channels.find(c => c.id === comm.channelId && c.memberNpcIds.includes(npcId));
    if (!channel || comm.targetNpcIds.some(id => !channel.memberNpcIds.includes(id))) throw new Error('참가할 수 없는 통신 채널·수신 대상입니다.');
    speechRecipients = (comm.targetNpcIds.length ? comm.targetNpcIds : channel.memberNpcIds).filter(id => id !== npcId);
  } else if (comm.targetNpcIds.length || output.speech.trim()) throw new Error('말하지 않는 선택에서는 대사·대화 대상을 비워 두세요.');
  return { locationId: position.locationId, virtualSeconds: state.virtualSeconds,
    speechRecipientIds: output.speech.trim() ? speechRecipients : [], actionRecipientIds: output.action.trim() ? neighbours : [] };
}

export function receives(u: Utterance, npcId: string) {
  return u.perception ? u.perception.speechRecipientIds.includes(npcId) || u.perception.actionRecipientIds.includes(npcId) : npcId !== u.speakerId;
}
export function visibleUtterance(u: Utterance, npcId: string): Utterance {
  if (!u.perception) return u;
  return { ...u, speech: u.speakerId === npcId || u.perception.speechRecipientIds.includes(npcId) ? u.speech : '',
    action: u.speakerId === npcId || u.perception.actionRecipientIds.includes(npcId) ? u.action : '',
    spatialIntent: undefined, knownUtteranceIds: undefined,
    // Evidence may quote a private utterance. It belongs to the reviewer, not listeners.
    worldEvent: u.worldEvent ? { ...u.worldEvent, evidence: null, audience: undefined } : undefined };
}

export function localContext(spec: ExperimentSpec, state: WorldState, npcId: string) {
  const s = state.spatial!; const pos = s.positions.find(p => p.npcId === npcId)!;
  const ownActivity = s.activities.find(a => a.npcId === npcId && a.status === 'pending' && a.kind === 'action');
  const space = spec.scenario.spatial!;
  const routes = pos.locationId ? space.connections.filter(r => state.virtualSeconds < (r.closesAtSeconds ?? Infinity) && (r.from === pos.locationId || r.bidirectional && r.to === pos.locationId)).map(r => ({
    connectionId: r.id, toLocationId: r.from === pos.locationId ? r.to : r.from, description: r.description,
  })) : pos.transit ? [pos.transit.from, pos.transit.to].map(id => ({ connectionId: pos.transit!.connectionId, toLocationId: id, description: '현재 통로의 끝' })) : [];
  return { virtualSeconds: state.virtualSeconds, location: pos.locationId ? space.locations.find(p => p.id === pos.locationId) && {
    id: pos.locationId, name: space.locations.find(p => p.id === pos.locationId)!.name, description: space.locations.find(p => p.id === pos.locationId)!.description,
  } : null, transit: pos.transit ? { from: pos.transit.from, to: pos.transit.to, connectionId: pos.transit.connectionId, moving: !!ownActivity?.moveToLocationId } : null,
    nearbyNpcs: s.positions.filter(p => p.npcId !== npcId && inSightAndSound(spec,state.virtualSeconds,p,pos)).map(p => ({ id: p.npcId, name: spec.scenario.characters.find(c => c.id === p.npcId)!.name, locationId:p.locationId })),
    routes: routes.map(r => ({ ...r, name: space.locations.find(l => l.id === r.toLocationId)!.name })),
    channels: space.channels.filter(c => c.memberNpcIds.includes(npcId)),
    closedPassages: space.connections.filter(r => state.virtualSeconds >= (r.closesAtSeconds ?? Infinity) &&
      (r.from === pos.locationId || r.to === pos.locationId)).map(r => ({id:r.id,closed:true})),
    visibleFacts: state.facts.filter(f => f.visibility === 'visible' && (f.scope === 'npc_physical'
      ? s.positions.some(p => p.npcId === f.npcId && positionKey(p) === positionKey(pos))
      : f.locationId === null || f.locationId === pos.locationId)).map(f => ({ id: f.id, text: f.text })),
    ongoingActivity: ownActivity ? { id: ownActivity.id, sourceUtteranceId: ownActivity.sourceUtteranceId, startedAtSeconds: ownActivity.startedAtSeconds, expectedEndSeconds: ownActivity.readyAtSeconds, moveToLocationId: ownActivity.moveToLocationId } : null,
  };
}
