import { randomUUID } from 'node:crypto';
import { eventProposalSchema, type EventGeneratorState, type SituationProposal } from '../shared/spatial-schema.js';
import type { SimulationHost } from './simulation-host.js';
import { managerState, managerWorld } from './spatial-prompts.js';
import { initialWorldState } from './world.js';

export const situationInstructions = `당신은 세계관 안에서 사건의 계기를 제안하는 상황 발생 관리자입니다. 한국어 JSON만 반환하고 도구를 사용하지 마세요. NPC의 비공개 기억·성격·목표를 알지 못하며 추측하지 마세요. 주어진 세계·장소·현재 상태·허용 범위에 맞춰 외부 상황을 하나 제안하거나 proposal:null로 침묵하세요.
매번 사건을 만들어야 하는 것은 아닙니다. 최근 제안과 반복되지 않게 하고 이미 진행 중인 사건을 불필요하게 겹치지 마세요. 사고·위협·갈등의 계기는 설정된 강도와 허용 범위 안에서 가능합니다. 그러나 NPC의 자발적 행동·대사·감정·판단을 정하지 마세요. NPC들이 무엇을 할지는 그들에게 맡기세요. 새로운 핵심 인물·장소·능력·역사는 추가 금지입니다. 제안은 세계 엔진이 별도로 검토하기 전까지 발생한 사실이 아닙니다.
locationIds는 사전에 선언된 실제 발생 장소입니다. 한 공간의 고장을 전 세계가 자동으로 안다고 가정하지 마세요. 단일 공간 모드에서는 빈 배열입니다. maxSeverity보다 높은 사건과 forbiddenEvents에 해당하는 사건은 제안하지 마세요. description은 발생 계기와 관찰 가능한 상황만 제안하며 캐릭터가 해결했다거나 죽음·부상 등 최종 결과를 미리 확정하지 마세요.`;

export function generatorState(h: SimulationHost): EventGeneratorState {
  const run = h.run(); return run.eventGeneratorState ?? { checks: 0, nextCheckAtSeconds: run.spec.eventGenerator!.intervalSeconds, lastAcceptedAtSeconds: null, proposals: [] };
}
export function pendingProposal(h: SimulationHost) { return h.run().eventGeneratorState?.proposals.find(p => p.status === 'proposed'); }
export function nextSituationCheck(h: SimulationHost) {
  const run = h.run(); if (!run.variant.eventGeneration || !run.spec.eventGenerator) return Infinity;
  const state = generatorState(h), config = run.spec.eventGenerator;
  if (state.checks >= config.maxChecks || state.proposals.length >= config.maxProposals) return Infinity;
  return Math.max(state.nextCheckAtSeconds, state.lastAcceptedAtSeconds === null ? 0 : state.lastAcceptedAtSeconds + config.minGapSeconds);
}
export async function generateSituation(h: SimulationHost) {
  const run = h.run(); if (!run.variant.eventGeneration || pendingProposal(h)) return;
  const time = run.worldState?.virtualSeconds ?? 0;
  if (time < nextSituationCheck(h)) return;
  const state = generatorState(h), config = run.spec.eventGenerator!;
  const session = await h.helper('situation-generator', config, situationInstructions);
  const call = await h.invoke('event_generation', session, `situation:${state.checks + 1}`, JSON.stringify({ task: 'event_generation', ...managerWorld(run.spec),
    current: managerState(run.worldState ?? initialWorldState(), h.store.list('utterances', h.id),run.spec),
    allowedEvents: config.allowedEvents, forbiddenEvents: config.forbiddenEvents, maxSeverity: config.maxSeverity,
    recentProposals: state.proposals.slice(-10), instruction: '지금 새로운 계기가 적절할 때만 한 건 제안하세요.' }));
  let proposal: SituationProposal | undefined;
  try {
    const output = eventProposalSchema.parse(JSON.parse(call.output));
    if (output.proposal) {
      const p = output.proposal, places = run.variant.environmentMode === 'ai_spatial' ? run.spec.scenario.spatial!.locations.map(l => l.id) : [];
      const severity = { low: 1, medium: 2, high: 3 };
      if (severity[p.severity] > severity[config.maxSeverity]) throw new Error('허용 강도를 넘는 상황 제안입니다.');
      if (new Set(p.locationIds).size !== p.locationIds.length || p.locationIds.some(id => !places.includes(id)) || run.variant.environmentMode === 'ai_spatial' && !p.locationIds.length) throw new Error('상황 발생 장소를 실제 선언된 장소로 지정하세요.');
      proposal = { ...p, id: randomUUID(), invocationId: call.id, virtualSeconds: time, status: 'proposed', reason: null };
    }
  } catch (error) { h.store.patch('invocations', call.id, { status: 'failed', error: error instanceof Error ? error.message : String(error) }); throw error; }
  if (h.run().status !== 'running') return;
  h.store.transaction(() => {
    const next = { ...state, checks: state.checks + 1, nextCheckAtSeconds: time + config.intervalSeconds, proposals: proposal ? [...state.proposals, proposal] : state.proposals };
    h.store.patch('runs', h.id, { eventGeneratorState: next });
    h.store.event(h.id, call.id, 'situation/proposed', { proposal: proposal ?? null, virtualSeconds: time });
  }); h.changed();
}
export function decideSituation(h: SimulationHost, proposal: SituationProposal, accepted: boolean, reason: string) {
  const state = generatorState(h);
  h.store.patch('runs', h.id, { eventGeneratorState: { ...state,
    lastAcceptedAtSeconds: accepted ? h.run().worldState!.virtualSeconds : state.lastAcceptedAtSeconds,
    proposals: state.proposals.map(p => p.id === proposal.id ? { ...p, status: accepted ? 'accepted' as const : 'rejected' as const, reason } : p) } });
  h.store.event(h.id, proposal.invocationId, 'situation/reviewed', { proposalId: proposal.id, accepted, reason });
}
