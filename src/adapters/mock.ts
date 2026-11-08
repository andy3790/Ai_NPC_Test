import { randomUUID } from 'node:crypto';
import type { Adapter, AdapterEvent, TurnRequest, TurnResult } from './types.js';
import type { ModelConfig } from '../shared/schema.js';
import type { ModelInfo, TokenUsage } from '../shared/types.js';
import { tokenKeys } from '../core/metrics.js';
export class MockAdapter implements Adapter {
  name = 'mock'; version = 'mock/1'; delayMs = 12;
  requests: TurnRequest[] = []; instructions = new Map<string, string>(); totals = new Map<string, TokenUsage>(); results = new Map<string, TurnResult>();
  failNextKind: string | null = null;
  private retainedInputs = new Map<string, Record<string, any>>();
  async models(): Promise<ModelInfo[]> { return [{ id: 'mock-model', name: '모의 모델', efforts: ['low', 'medium', 'high'], defaultEffort: 'low', isDefault: true }]; }
  async createSession(_config: ModelConfig, instructions: string, _cwd: string) { const id = randomUUID(); this.instructions.set(id, instructions); this.totals.set(id, Object.fromEntries(tokenKeys.map(k => [k, 0])) as unknown as TokenUsage); return id; }
  async resumeSession(_threadId: string) {}
  baseline(threadId: string) { return this.totals.get(threadId) ?? null; }
  async turn(r: TurnRequest, emit: (e: AdapterEvent) => void, signal?: AbortSignal): Promise<TurnResult> {
    this.requests.push(r); const turnId = randomUUID(); const rawInput = JSON.parse(r.input);
    const key = `${r.threadId}:${rawInput.task}`;
    const input = rawInput.previousFailure !== undefined ? this.retainedInputs.get(key) ?? rawInput : rawInput;
    if (rawInput.previousFailure === undefined) this.retainedInputs.set(key, input);
    emit({ method: 'turn/accepted', params: { threadId: r.threadId, turnId } });
    await new Promise(resolve => setTimeout(resolve, this.delayMs));
    if (signal?.aborted) return { turnId, output: '', status: 'cancelled', error: '취소' };
    if (this.failNextKind === input.task) { this.failNextKind = null; const failure: TurnResult = { turnId, output: '', status: 'failed', error: '모의 실패' }; this.results.set(turnId, failure); return failure; }
    let output: unknown;
    if (input.task === 'receive') output = { received: true };
    else if (input.task === 'event_generation') output = { proposal: null };
    else if (input.task === 'spatial_plan') output = { plans: (input.choices ?? []).map((u: any) => ({ utteranceId: u.id, speechSeconds: u.speech ? 1 : 0, actionSeconds: u.action ? 3 : 0, reactionNpcIds: [], movementStarts: !!u.spatialIntent.moveToLocationId })) };
    else if (input.task === 'spatial_resolve') {
      const due = (input.current.activities ?? []).filter((a: any) => input.dueActivityIds.includes(a.id));
      output = { completedActivities: due.map((a: any) => ({ id: a.id, outcome: 'completed', reason: '모의 결과' })), activityUpdates: [],
        movements: due.filter((a: any) => a.moveToLocationId && input.current.positions.some((p: any) => p.transit?.activityId === a.id)).map((a: any) => ({ npcId: a.npcId, activityId: a.id, toLocationId: a.moveToLocationId, kind: 'requested' })),
        facts: [], forgetFactIds: [], processes: [],
        finishProcesses: (input.current.processes ?? []).filter((p: any) => p.readyAtSeconds <= input.currentTime && !p.waitingNpcIds.length).map((p: any) => ({ id: p.id, outcome: 'completed', reason: '모의 사건 종료' })),
        events: input.proposal ? [{ type: 'external_signal', text: input.proposal.description, npcId: null, evidence: null, processId: null, sourceUtteranceId: null, proposalId: input.proposal.id,
          audience: { scope: 'locations', locationIds: input.proposal.locationIds, npcIds: [] } }] : [],
        proposalDecision: input.proposal ? { accepted: true, reason: '모의 검토' } : null };
    }
    else if (input.task === 'environment') output = { elapsedSeconds: 3, facts: [], forgetFactIds: [], processes: [], finishProcesses: [], events: [] };
    else if (input.task === 'situation_resolve') output = { elapsedSeconds: 0, facts: [], forgetFactIds: [], processes: [], finishProcesses: [],
      events: [{ type: 'external_signal', text: input.proposal.description, npcId: null, evidence: null, processId: null }], proposalDecision: { accepted: true, reason: '모의 검토' } };
    else if (input.task === 'direct') output = { speakerId: input.allowedSpeakerIds[0], reason: '최근 발화 순서에 따라 선택' };
    else if (input.task === 'evaluate') {
      const findings = input.history.filter((u: any) => input.targetIds.includes(u.id)).flatMap((u: any) => {
        const samples = [['용을 소환', 'world_expansion'], ['기름은 무한', 'memory'], ['야 이 멍청아', 'speech_style']];
        return samples.filter(([q]) => u.speech.includes(q)).map(([q, category]) => ({ utteranceId: u.id, category, severity: 'high', verdict: 'issue', quote: q, reference: '원본 캐릭터·세계관', explanation: '모의 평가 예제에 해당하는 설정 이탈' }));
      });
      output = { findings, summary: '모의 평가 — 실제 AI 판단이 아닙니다.' };
    } else if (input.localContext) {
      const alone = !input.localContext.nearbyNpcs.length;
      output = { speech: alone ? '' : '여기서 잠시 둘러볼게요.', action: '주변을 살핀다.', communication: { mode: alone ? 'none' : 'local', targetNpcIds: [], channelId: null }, moveToLocationId: null, activityChoice: input.localContext.ongoingActivity ? 'continue' : 'start' };
    } else {
      const action = input.environment?.availableActions?.[0];
      output = { speech: action ? `${action.label} — 지금 시도하겠습니다.` : `남은 기름을 어떻게 나눌지 함께 생각해 봅시다. (${this.requests.filter(x => JSON.parse(x.input).task === 'speak').length})`, action: action ? action.label : '등대 쪽을 바라본다.', ...(input.environment ? { actionId: action?.id ?? null } : {}) };
    }
    if (input.characterPerformance?.select && output && typeof output === 'object') {
      output = { portrayal: { attention: '말에서 빠진 대목', phrasing: '구체적인 한 대목부터 꺼낸다' }, ...output };
    }
    const schema=r.outputSchema as {properties?:{speech?:{type?:string};setAsideSequence?:object;socialChoice?:object;reaction?:object}};
    if (schema.properties?.reaction && output && typeof output==='object' && 'speech' in output) {
      const {speech,action:_action,...rest}=output as {speech:string;action:string};
      output={...rest,reaction:{speech,action:''}};
    }
    if (schema.properties?.socialChoice && output && typeof output==='object') output={...output,socialChoice:null};
    if (schema.properties?.setAsideSequence && output && typeof output==='object') output={...output,setAsideSequence:null};
    if (schema.properties?.speech?.type==='array' && output && typeof output==='object' && 'speech' in output && typeof output.speech==='string') {
      output={...output,speech:output.speech ? [output.speech] : []};
    }
    const text = JSON.stringify(output); emit({ method: 'item/agentMessage/delta', params: { threadId: r.threadId, turnId, delta: text } });
    const prev = this.totals.get(r.threadId); const last = { inputTokens: Math.ceil(r.input.length / 2), cachedInputTokens: 10, cacheWriteInputTokens: 0, outputTokens: Math.ceil(text.length / 2), reasoningOutputTokens: 5, totalTokens: Math.ceil(r.input.length / 2) + Math.ceil(text.length / 2) };
    const total = Object.fromEntries(tokenKeys.map(k => [k, (prev?.[k] ?? 0) + last[k]])) as unknown as TokenUsage;
    this.totals.set(r.threadId, total);
    emit({ method: 'thread/tokenUsage/updated', params: { threadId: r.threadId, turnId, tokenUsage: { last, total } } });
    const result: TurnResult = { turnId, output: text, status: 'completed' }; this.results.set(turnId, result); return result;
  }
  async reconcile(_threadId: string, turnId: string | null): Promise<TurnResult | null> { return turnId ? this.results.get(turnId) ?? null : null; }
  async close() {}
}
