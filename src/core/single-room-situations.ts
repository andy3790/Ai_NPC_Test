import { randomUUID } from 'node:crypto';
import { situationResolutionSchema } from '../shared/schema.js';
import type { Utterance } from '../shared/types.js';
import type { SimulationHost } from './simulation-host.js';
import { decideSituation, generateSituation, pendingProposal, proposalCause } from './situations.js';
import { managerState, managerWorld } from './spatial-prompts.js';
import { usesSceneFlowV2 } from './scene-flow.js';
import { applyWorldOutput, initialWorldState, worldInstructions } from './world.js';

export async function advanceSingleRoomSituations(h: SimulationHost) {
  if (!h.run().variant.eventGeneration || h.run().status !== 'running') return;
  await generateSituation(h);
  const proposal = pendingProposal(h); if (!proposal) return;
  const run = h.run(), state = run.worldState ?? initialWorldState();
  const session = await h.helper('world-situation-review', run.spec.worldEngine!, worldInstructions + `
지금은 상황 생성기의 제안을 검토합니다. proposal은 아직 사실이 아닙니다. 세계 설정·허용 범위·금지 사항에 맞으면 proposalDecision.accepted=true로 채택하고 관찰·진행 사건을 반영하세요. 아니면 이유와 함께 거절하고 나머지 변경 배열을 모두 비우세요. elapsedSeconds는 반드시 0입니다. 기존 NPC의 자발적 행동 결과(actor_result)는 만들 수 없습니다. NPC의 반응이 필요한 물리 결과는 공개 징후와 반응 대기 사건으로 먼저 등록하세요.`);
  const history = h.store.list('utterances', h.id);
  const call = await h.invoke('environment', session, `situation:resolve:${proposal.id}`, JSON.stringify({ task: 'situation_resolve',
    ...managerWorld(run.spec), current: managerState(state, history), proposal,
    ...(usesSceneFlowV2(run.sceneFlowVersion) && proposalCause(proposal,history)), policy: run.spec.eventGenerator }),
    { outputType: 'situationResolution', phase: 'situation', proposalId: proposal.id, virtualSeconds: state.virtualSeconds }, history);
  let result: ReturnType<typeof applyWorldOutput>, decision: { accepted: boolean; reason: string };
  try {
    const output = situationResolutionSchema.parse(JSON.parse(call.output)); decision = output.proposalDecision;
    if (output.elapsedSeconds !== 0 || output.events.some(e => e.type === 'actor_result')) throw new Error('상황 검토는 시간을 진행시키거나 NPC 행동을 대신 결정할 수 없습니다.');
    const changes = [output.facts, output.forgetFactIds, output.processes, output.finishProcesses, output.events];
    if (!decision.accepted && changes.some(a => a.length)) throw new Error('거절된 상황은 세계에 반영할 수 없습니다.');
    if (decision.accepted && !changes.some(a => a.length)) throw new Error('채택한 상황의 반영 내용이 없습니다.');
    const source: Utterance = { id: proposal.id, runId: h.id, sequence: state.processedSequence, speechIndex: state.processedSpeechCount,
      speakerId: '__situation__', speakerName: '상황 제안', kind: 'event', speech: proposal.description, action: '',
      createdAt: new Date().toISOString(), invocationId: call.id, deliveryCompletedAt: null, deliveryMs: null };
    result = applyWorldOutput(state, output, source, run.spec.scenario.characters.map(c => c.id));
    Object.assign(result.state, { processedSpeechId: state.processedSpeechId, processedSequence: state.processedSequence, processedSpeechCount: state.processedSpeechCount });
  } catch (e) { h.store.patch('invocations', call.id, { status: 'failed', error: e instanceof Error ? e.message : String(e) }); throw e; }
  if (h.run().status !== 'running') return;
  h.store.transaction(() => {
    let sequence = h.store.list('utterances', h.id).length;
    for (const event of result.output.events) h.append({ id: randomUUID(), runId: h.id, sequence: ++sequence, speechIndex: null,
      speakerId: '__environment__', speakerName: '세계 엔진', kind: 'event', speech: event.text, action: '', createdAt: new Date().toISOString(),
      invocationId: call.id, deliveryCompletedAt: null, deliveryMs: null,
      worldEvent: { ...event, sourceUtteranceId: null, proposalId: proposal.id, virtualSeconds: state.virtualSeconds } });
    h.store.patch('runs', h.id, { worldState: result.state });
    h.store.event(h.id, call.id, 'world/committed', { proposalId: proposal.id, state: result.state, events: result.output.events });
    decideSituation(h, proposal, decision.accepted, decision.reason);
  }); h.changed();
}
