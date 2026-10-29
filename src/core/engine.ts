import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Adapter } from '../adapters/types.js';
import { Store } from './store.js';
import { aggregate, emptyUsage, UsageTracker } from './metrics.js';
import { evaluationPrompt, persona, PROMPT_VERSION, publicMessage, receiverPrompt, speakerPrompt } from './prompts.js';
import { directorSchema, evaluationSchema, experimentSchema, outputSchemas, receiveSchema, speechSchema, type ExperimentSpec, type ModelConfig } from '../shared/schema.js';
import type { CallKind, DeliveryReceipt, InvocationMetrics, NpcSession, Run, RunDetail, Utterance } from '../shared/types.js';
import { progression, progressionPrompt, resolveAction } from './progression.js';
import { qualityMetrics, repetitionMetrics } from './quality.js';
import { APP_VERSION } from '../shared/version.js';

const now = () => new Date().toISOString();
const err = (e: unknown) => e instanceof Error ? e.message : String(e);
class Slots {
  active = 0; waiters: (() => void)[] = []; limit = 2;
  async enter() { if (this.active >= this.limit) await new Promise<void>(r => this.waiters.push(r)); else this.active++; }
  leave() { this.active--; while (this.active < this.limit && this.waiters.length) { this.active++; this.waiters.shift()!(); } }
}
export class Engine extends EventEmitter {
  private workers = new Map<string, Promise<void>>();
  private aborts = new Map<string, Set<AbortController>>();
  private slots = new Slots(); private closing = false;
  private activeStarts = new Map<string, number>();
  private resuming = new Set<string>();
  constructor(public store: Store, public adapter: Adapter, public dataDir: string) {
    super();
    for (const run of store.list('runs')) if (['running', 'queued'].includes(run.status)) store.patch('runs', run.id, { status: 'paused', pausedAt: now(), timingComplete: run.status === 'running' ? false : run.timingComplete, error: '서버 재시작: 재개 전에 미확정 호출을 확인합니다.' });
    for (const call of store.list('invocations')) {
      if (call.status === 'running') store.patch('invocations', call.id, { status: 'uncertain', error: '서버 재시작으로 완료 확인 필요' });
      if (call.status === 'queued') store.patch('invocations', call.id, { status: 'cancelled', error: '전송 전 서버 재시작', completedAt: now() });
    }
  }
  private changed(runId: string) { this.emit('change', { runId, at: now() }); }
  run(id: string) { const r = this.store.get('runs', id); if (!r) throw new Error('대화 묶음이 없습니다.'); return r; }
  async validate(spec: unknown): Promise<ExperimentSpec> {
    const parsed = experimentSchema.parse(spec); const models = await this.adapter.models();
    const check = (config: ModelConfig) => {
      const model = models.find(m => m.id === config.model);
      if (!model || !model.efforts.includes(config.effort)) throw new Error(`사용할 수 없는 모델·추론 조합: ${config.model} / ${config.effort}`);
      if (config.effort === 'ultra') throw new Error('ultra는 자동 위임을 활성화하므로 독립 NPC 세션 실험에서는 사용할 수 없습니다. max 이하를 선택하세요.');
    };
    for (const v of parsed.variants) for (const c of parsed.scenario.characters) check({ model: c.model ?? v.model ?? parsed.scenario.defaults.model, effort: c.effort ?? v.effort ?? parsed.scenario.defaults.effort });
    if (parsed.evaluation.enabled) check(parsed.evaluation);
    if (parsed.variants.some(v => v.turnPolicy === 'director')) check(parsed.director);
    return parsed;
  }
  async create(input: unknown, start = true) {
    const spec = await this.validate(input); const experimentId = randomUUID(); const runs: Run[] = [];
    for (const variant of spec.variants) for (let repetition = 1; repetition <= spec.repetitions; repetition++) {
      const snapshotHash = createHash('sha256').update(JSON.stringify({ spec, variant, repetition, promptVersion: PROMPT_VERSION })).digest('hex');
      const run: Run = { id: randomUUID(), experimentId, name: `${spec.name} · ${variant.label} · #${repetition}`, variant, repetition, spec, snapshotHash,
        status: start ? 'queued' : 'paused', error: null, createdAt: now(), startedAt: null, completedAt: null, activeMs: 0, pausedMs: 0, pausedAt: start ? null : now(), timingComplete: true,
        sessions: {}, helperSessions: {}, lastSpeakerId: null, nextSpeakerId: null, evaluatedThrough: 0, appliedEvents: [], stepRemaining: null, pauseRequested: false,
        revisions: 0, adapter: this.adapter.name, appVersion: APP_VERSION, cliVersion: this.adapter.version };
      this.store.put('runs', run); runs.push(run); this.changed(run.id);
    }
    this.store.setting('lastSpec', spec); this.pump(); return { experimentId, runs };
  }
  private pump() {
    if (this.closing) return;
    for (const run of this.store.list('runs').filter(r => r.status === 'queued')) {
      const active = [...this.workers.keys()].map(id => this.run(id));
      if (active.filter(r => r.experimentId === run.experimentId).length >= run.spec.concurrentRuns || active.length >= 16) continue;
      const pausedMs = run.pausedMs + (run.pausedAt ? Date.now() - Date.parse(run.pausedAt) : 0);
      this.store.patch('runs', run.id, { status: 'running', startedAt: run.startedAt ?? now(), pausedAt: null, pausedMs, error: null });
      this.slots.limit = Math.min(run.spec.maxConcurrentCalls, ...active.map(r => r.spec.maxConcurrentCalls));
      const worker = this.work(run.id).catch(e => {
        if (this.run(run.id).status !== 'stopped') this.store.patch('runs', run.id, { status: 'paused', pausedAt: now(), error: err(e) });
      }).finally(() => { this.workers.delete(run.id); this.changed(run.id); this.pump(); });
      this.workers.set(run.id, worker); this.changed(run.id);
    }
  }
  private async sessions(id: string) {
    for (const c of this.run(id).spec.scenario.characters) {
      const run = this.run(id); if (run.sessions[c.id]) { await this.restoreSession(id, 'sessions', c.id, run.sessions[c.id]); continue; }
      const config = { model: c.model ?? run.variant.model ?? run.spec.scenario.defaults.model, effort: c.effort ?? run.variant.effort ?? run.spec.scenario.defaults.effort };
      const instructions = persona(run.spec, c);
      const threadId = await this.adapter.createSession(config, instructions, join(this.dataDir, 'sessions', id, c.id));
      this.store.patch('runs', id, { sessions: { ...this.run(id).sessions, [c.id]: { id: randomUUID(), characterId: c.id, threadId, config, instructions } } });
    }
  }
  private async restoreSession(id: string, collection: 'sessions' | 'helperSessions', key: string, session: NpcSession) {
    try { await this.adapter.resumeSession(session.threadId); return session; }
    catch (e) {
      // Codex does not persist an empty thread until its first turn. Recreate only
      // when the ledger proves that no request could have been sent to this thread.
      const everSent = this.store.list('invocations', id).some(c => c.threadId === session.threadId && c.startedAt !== null);
      if (everSent || !err(e).includes('no rollout found for thread id')) throw e;
      const threadId = await this.adapter.createSession(session.config, session.instructions, join(this.dataDir, 'sessions', id, key));
      const restored = { ...session, threadId };
      this.store.patch('runs', id, { [collection]: { ...this.run(id)[collection], [key]: restored } });
      this.store.event(id, null, 'session/recreated_empty', { sessionId: session.id, oldThreadId: session.threadId, newThreadId: threadId, reason: 'Codex did not persist a never-invoked thread' });
      return restored;
    }
  }
  private async helper(id: string, key: string, config: ModelConfig, instructions: string): Promise<NpcSession> {
    const old = this.run(id).helperSessions[key]; if (old) return this.restoreSession(id, 'helperSessions', key, old);
    const threadId = await this.adapter.createSession(config, instructions, join(this.dataDir, 'sessions', id, key));
    const session = { id: randomUUID(), characterId: key, threadId, config, instructions };
    this.store.patch('runs', id, { helperSessions: { ...this.run(id).helperSessions, [key]: session } }); return session;
  }
  private async invoke(id: string, kind: CallKind, session: NpcSession, operationKey: string, input: string, metadata: Record<string, unknown> = {}) {
    const previous = this.store.list('invocations', id).filter(c => c.operationKey === operationKey).at(-1);
    if (previous?.status === 'completed') return previous;
    if (previous && ['uncertain', 'running'].includes(previous.status)) throw new Error(`미확정 호출 ${previous.id}: 자동 재전송하지 않습니다. 재개하여 상태를 확인하세요.`);
    // A failed accepted turn already appended its input. A retry asks to complete that input,
    // without appending the dialogue payload a second time to the same persistent session.
    if (previous?.turnId) input = JSON.stringify({ task: JSON.parse(input).task, instruction: '바로 이전 요청은 실패하거나 형식이 잘못되었습니다. 이미 전달된 이전 요청의 내용을 사용하여 그 요청만 다시 완료하세요. 새 공개 발언이나 세계 설정을 입력한 것이 아닙니다. 지정된 JSON 형식만 반환하세요.' });
    const run = this.run(id); const call: InvocationMetrics = {
      id: randomUUID(), experimentId: run.experimentId, runId: id, variantId: run.variant.id, repetition: run.repetition,
      kind, characterId: ['speech', 'receive'].includes(kind) ? session.characterId : null, operationKey, attempt: (previous?.attempt ?? 0) + 1, retryOf: previous?.id ?? null,
      threadId: session.threadId, turnId: null, sourceUtteranceId: (metadata.sourceUtteranceId as string) ?? null, utteranceId: null,
      model: session.config.model, effort: session.config.effort, actualModel: null, deliveryMode: run.variant.deliveryMode, memoryMode: run.variant.memoryMode,
      queuedAt: now(), startedAt: null, firstOutputAt: null, completedAt: null, queueMs: null, firstOutputMs: null, durationMs: null,
      status: 'queued', usage: emptyUsage(), usageStatus: 'not_started', input, output: '', error: null, metadata: { ...metadata, adapter: run.adapter, appVersion: run.appVersion, cliVersion: run.cliVersion, promptVersion: PROMPT_VERSION },
    };
    this.store.put('invocations', call); this.changed(id); const queued = performance.now();
    await this.slots.enter();
    let begin = performance.now();
    try {
      if (['stopped'].includes(this.run(id).status) || this.closing) throw new Error('전송 전 실행 중단');
      await this.adapter.resumeSession(session.threadId);
      const tracker = new UsageTracker(this.adapter.baseline(session.threadId));
      begin = performance.now(); Object.assign(call, { startedAt: now(), queueMs: begin - queued, status: 'running' }); this.store.put('invocations', call);
      const controller = new AbortController(); const set = this.aborts.get(id) ?? new Set(); set.add(controller); this.aborts.set(id, set);
      let result;
      try {
        result = await this.adapter.turn({ threadId: session.threadId, config: session.config, input, outputSchema: kind === 'speech' && run.spec.scenario.environment?.enabled ? outputSchemas.progressSpeech : outputSchemas[kind], clientMessageId: call.id, timeoutMs: run.spec.timeoutMs }, event => {
          // Late usage events must preserve fields committed after the turn completed.
          Object.assign(call, this.store.get('invocations', call.id));
          this.store.event(id, call.id, event.method, event.params);
          if (event.method === 'turn/accepted' || event.method === 'turn/started') call.turnId = event.params.turnId ?? event.params.turn?.id;
          if (event.method === 'item/agentMessage/delta' && !call.firstOutputAt) { call.firstOutputAt = now(); call.firstOutputMs = performance.now() - begin; }
          if (event.method === 'thread/tokenUsage/updated') { tracker.update(event.params); const result = tracker.result(); call.usage = result.usage; call.usageStatus = result.status; }
          if (event.method === 'model/rerouted') call.actualModel = event.params.toModel;
          if (event.method === 'item/started' && event.params.item?.type === 'contextCompaction') call.metadata.compactions = Number(call.metadata.compactions ?? 0) + 1;
          this.store.put('invocations', call); this.changed(id);
        }, controller.signal);
      } finally { set.delete(controller); }
      const usage = tracker.result();
      Object.assign(call, { turnId: result.turnId || call.turnId, output: result.output, status: result.status, error: result.error ?? null,
        completedAt: now(), durationMs: performance.now() - begin, usage: usage.usage, usageStatus: usage.status });
      if (call.status === 'completed') {
        try {
          const parsed = JSON.parse(call.output);
          ({ speech: speechSchema, receive: receiveSchema, director: directorSchema, evaluation: evaluationSchema }[kind]).parse(parsed);
        } catch (e) { call.status = 'failed'; call.error = `출력 형식 오류: ${err(e)}`; }
      }
      this.store.put('invocations', call);
      if (call.status !== 'completed') throw new Error(`${kind} 호출 ${call.status}: ${call.error ?? ''}`);
      return call;
    } catch (e) {
      if (call.status === 'queued') { call.status = 'cancelled'; call.error = err(e); call.completedAt = now(); }
      else if (call.status === 'running') { call.status = 'uncertain'; call.error = err(e); call.completedAt = now(); call.durationMs = performance.now() - begin; }
      this.store.put('invocations', call); throw e;
    } finally { this.slots.leave(); this.changed(id); }
  }
  private pending(id: string, characterId?: string) { return this.store.list('receipts', id).filter(r => r.status !== 'delivered' && (!characterId || r.characterId === characterId)); }
  private completeDelivery(id: string, u: Utterance) {
    const all = this.store.list('receipts', id).filter(r => r.utteranceId === u.id);
    if (all.every(r => r.status === 'delivered') && !u.deliveryCompletedAt) {
      this.store.patch('utterances', u.id, { deliveryCompletedAt: now(), deliveryMs: Date.now() - Date.parse(u.createdAt) });
    }
  }
  private async flush(id: string) {
    if (this.run(id).variant.deliveryMode !== 'per_utterance') return;
    // Barrier per public event: preserve order even when resuming multiple pending events.
    for (const u of this.store.list('utterances', id)) {
      const receipts = this.pending(id).filter(r => r.utteranceId === u.id);
      const results = await Promise.allSettled(receipts.map(async receipt => {
        const session = this.run(id).sessions[receipt.characterId];
        this.store.patch('receipts', receipt.id, { status: 'processing' });
        const call = await this.invoke(id, 'receive', session, `receive:${receipt.id}`, receiverPrompt(u), { sourceUtteranceId: u.id, receiptIds: [receipt.id] });
        this.store.patch('receipts', receipt.id, { status: 'delivered', invocationId: call.id, deliveredAt: now() });
      }));
      const failed = results.find(x => x.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      this.completeDelivery(id, u);
    }
  }
  private append(id: string, u: Utterance) {
    this.store.put('utterances', u);
    for (const c of this.run(id).spec.scenario.characters) if (c.id !== u.speakerId) {
      const receipt: DeliveryReceipt = { id: `${u.id}:${c.id}`, runId: id, utteranceId: u.id, characterId: c.id, status: 'pending', invocationId: null, deliveredAt: null };
      this.store.put('receipts', receipt);
    }
  }
  private async speaker(id: string, speeches: Utterance[]) {
    const run = this.run(id); if (run.nextSpeakerId) return run.nextSpeakerId;
    const chars = run.spec.scenario.characters; let selected = chars[speeches.length % chars.length].id;
    if (run.variant.turnPolicy === 'director' && speeches.length) {
      const age = (characterId: string) => speeches.length - (speeches.findLastIndex(u => u.speakerId === characterId));
      const candidates = chars.filter(c => c.id !== run.lastSpeakerId).sort((a, b) => age(b.id) - age(a.id));
      const allowed = age(candidates[0].id) >= chars.length * 2 ? [candidates[0]] : candidates;
      const session = await this.helper(id, 'director', run.spec.director, '당신은 대화 진행자입니다. 허용된 ID 중 다음 화자 하나만 선택하세요. 공개 대화 외의 설정이나 대사를 만들지 마세요.');
      const call = await this.invoke(id, 'director', session, `director:${speeches.length + 1}`, JSON.stringify({ task: 'direct', allowedSpeakerIds: allowed.map(c => c.id), history: this.store.list('utterances', id).slice(-50).map(publicMessage) }));
      selected = JSON.parse(call.output).speakerId;
      if (!allowed.some(c => c.id === selected)) { this.store.patch('invocations', call.id, { status: 'failed', error: '허용되지 않은 화자 ID' }); throw new Error('진행자가 허용되지 않은 화자를 선택했습니다.'); }
    }
    this.store.patch('runs', id, { nextSpeakerId: selected }); return selected;
  }
  private async work(id: string) {
    const began = performance.now();
    this.activeStarts.set(id, began);
    try {
      await this.sessions(id);
      while (!this.closing && this.run(id).status === 'running') {
        await this.flush(id);
        let run = this.run(id); let all = this.store.list('utterances', id); let speeches = all.filter(u => u.kind === 'speech');
        for (const [index, event] of run.spec.scheduledEvents.entries()) if (event.afterUtterance <= speeches.length && !this.run(id).appliedEvents.includes(index)) {
          this.store.transaction(() => { this.appendEvent(id, event.text); this.store.patch('runs', id, { appliedEvents: [...this.run(id).appliedEvents, index] }); });
        }
        await this.flush(id);
        const goalsDone = !!(run.spec.scenario.environment?.enabled && run.spec.scenario.environment.stopOnGoals && progression(run.spec, this.store.list('utterances', id))?.allGoalsAchieved);
        await this.evaluatePending(id, speeches.length >= run.spec.maxUtterances || goalsDone);
        run = this.run(id);
        if (run.status !== 'running') break;
        if (speeches.length >= run.spec.maxUtterances || goalsDone) { this.store.patch('runs', id, { status: 'completed', completedAt: now(), completionReason: goalsDone ? 'goals_achieved' : 'utterance_limit' }); break; }
        if (run.pauseRequested || run.stepRemaining === 0) { this.store.patch('runs', id, { status: 'paused', pausedAt: now(), pauseRequested: false }); break; }
        const speakerId = await this.speaker(id, speeches); const session = this.run(id).sessions[speakerId];
        const receipts = this.pending(id, speakerId); all = this.store.list('utterances', id);
        const messages = all.filter(u => receipts.some(r => r.utteranceId === u.id));
        const call = await this.invoke(id, 'speech', session, `speech:${speeches.length + 1}`, speakerPrompt(messages, run.variant.memoryMode === 'reinject_on_speech' ? session.instructions : undefined, progressionPrompt(run.spec, all, speakerId)), { receiptIds: receipts.map(r => r.id) });
        const output = speechSchema.parse(JSON.parse(call.output)); const character = run.spec.scenario.characters.find(c => c.id === speakerId)!;
        let resolved: ReturnType<typeof resolveAction>;
        try { resolved = resolveAction(run.spec, all, speakerId, output.actionId); }
        catch (e) { this.store.patch('invocations', call.id, { status: 'failed', error: err(e) }); throw e; }
        this.store.transaction(() => {
          const u: Utterance = { id: randomUUID(), runId: id, sequence: all.length + 1, speechIndex: speeches.length + 1, speakerId, speakerName: character.name, kind: 'speech', speech: output.speech, action: output.action, actionId: output.actionId ?? null, createdAt: now(), invocationId: call.id, deliveryCompletedAt: null, deliveryMs: null };
          this.append(id, u);
          if (resolved) {
            const resolution = { actionId: resolved.action.id, sourceUtteranceId: u.id, speechIndex: u.speechIndex!, actorId: speakerId, before: resolved.before, after: resolved.after };
            this.append(id, { id: randomUUID(), runId: id, sequence: u.sequence + 1, speechIndex: null, speakerId: '__environment__', speakerName: '환경 결과', kind: 'event', speech: resolved.action.result, action: '', resolution, createdAt: now(), invocationId: null, deliveryCompletedAt: null, deliveryMs: null });
            this.store.event(id, call.id, 'environment/resolved', resolution);
          }
          for (const attempt of this.store.list('invocations', id).filter(c => c.operationKey === call.operationKey)) this.store.patch('invocations', attempt.id, { utteranceId: u.id });
          for (const r of receipts) this.store.patch('receipts', r.id, { status: 'delivered', invocationId: call.id, deliveredAt: now() });
          for (const old of messages) this.completeDelivery(id, old);
          const current = this.run(id);
          this.store.patch('runs', id, { lastSpeakerId: speakerId, nextSpeakerId: null, stepRemaining: current.stepRemaining === null ? null : Math.max(0, current.stepRemaining - 1) });
        });
        this.changed(id);
      }
      if (this.closing && this.run(id).status === 'running') this.store.patch('runs', id, { status: 'paused', pausedAt: now() });
    } finally {
      this.store.patch('runs', id, { activeMs: this.run(id).activeMs + performance.now() - began, ...(this.run(id).status === 'stopped' ? { completedAt: now() } : {}) });
      this.activeStarts.delete(id);
    }
  }
  private async evaluateRange(id: string, from: number, to: number) {
    const run = this.run(id); const evalId = `${id}:eval:${from}:${to}`;
    if (this.store.get('evaluations', evalId)?.status === 'completed') return;
    const history = this.store.list('utterances', id);
    // Include the target's authoritative outcome, but never a later speech/result.
    const nextSequence = history.find(u => u.speechIndex !== null && u.speechIndex > to)?.sequence ?? Infinity;
    const bounded = history.filter(u => u.sequence < nextSequence);
    const targets = bounded.filter(u => u.speechIndex !== null && u.speechIndex >= from && u.speechIndex <= to);
    const prompt = evaluationPrompt(run.spec, bounded, targets); let call: InvocationMetrics | undefined;
    try {
      const session = await this.helper(id, `judge-${from}-${to}`, run.spec.evaluation, '당신은 NPC 대화의 독립 평가자입니다. 제공한 설정과 공개 기록에서 확인 가능한 근거만 사용하세요. 대화를 교정하거나 참여하지 마세요.');
      call = await this.invoke(id, 'evaluation', session, `eval:${from}:${to}`, prompt.input, { from, to, contextTruncated: prompt.truncated });
      const result = evaluationSchema.parse(JSON.parse(call.output));
      for (const f of result.findings) {
        const u = targets.find(u => u.id === f.utteranceId);
        if (!u || !f.quote || !(u.speech.includes(f.quote) || u.action.includes(f.quote))) throw new Error('평가 근거가 대상 발화와 일치하지 않습니다.');
      }
      this.store.transaction(() => {
        this.store.put('evaluations', { id: evalId, runId: id, from, to, status: 'completed', contextTruncated: prompt.truncated, summary: result.summary, invocationId: call!.id, error: null, quality: { repetition: repetitionMetrics(run.spec, bounded), progression: progression(run.spec, bounded) } });
        for (const f of result.findings) this.store.put('findings', { ...f, id: randomUUID(), runId: id, evaluationId: evalId, review: 'unreviewed', note: '' });
      });
    } catch (e) {
      if (call) this.store.patch('invocations', call.id, { status: 'failed', error: err(e) });
      this.store.put('evaluations', { id: evalId, runId: id, from, to, status: 'failed', contextTruncated: prompt.truncated, summary: '', invocationId: call?.id ?? null, error: err(e) });
    }
  }
  private async evaluatePending(id: string, final: boolean) {
    const run = this.run(id); if (!run.spec.evaluation.enabled) return;
    const count = this.store.list('utterances', id).filter(u => u.kind === 'speech').length;
    while (this.run(id).evaluatedThrough < count) {
      const from = this.run(id).evaluatedThrough + 1; const to = Math.min(count, from + run.spec.evaluation.interval - 1);
      if (!final && to - from + 1 < run.spec.evaluation.interval) break;
      await this.evaluateRange(id, from, to); this.store.patch('runs', id, { evaluatedThrough: to });
    }
  }
  async evaluate(id: string) {
    const run = this.run(id); if (this.workers.has(id)) throw new Error('일시정지한 후 수동 평가를 실행하세요.');
    if (!run.spec.evaluation.enabled) throw new Error('이 실험의 자동 평가 설정이 꺼져 있습니다.');
    const worker = (async () => { for (const e of this.store.list('evaluations', id).filter(x => x.status === 'failed')) await this.evaluateRange(id, e.from, e.to); await this.evaluatePending(id, true); })();
    this.workers.set(id, worker);
    try { await worker; } finally { this.workers.delete(id); this.changed(id); this.pump(); }
  }
  async pause(id: string) {
    const run = this.run(id);
    if (run.status === 'queued') this.store.patch('runs', id, { status: 'paused', pausedAt: now() });
    if (run.status === 'running') this.store.patch('runs', id, { pauseRequested: true });
    this.changed(id);
  }
  async resume(id: string, step = false) {
    const run = this.run(id); if (this.workers.has(id) || this.resuming.has(id)) throw new Error('현재 진행 중인 요청이 끝난 뒤 재개하세요.');
    if (['completed', 'stopped'].includes(run.status)) throw new Error('종료된 묶음은 재개할 수 없습니다. 같은 설정으로 새 실험을 실행하세요.');
    if (run.adapter !== this.adapter.name) throw new Error('저장된 실험과 현재 서버의 어댑터가 다릅니다.');
    this.resuming.add(id);
    try {
      for (const call of this.store.list('invocations', id).filter(c => ['uncertain', 'running'].includes(c.status))) {
        const result = await this.adapter.reconcile(call.threadId, call.turnId, call.id);
        if (!result) throw new Error(`호출 ${call.id}의 완료 상태를 확인할 수 없습니다. 자동 재전송하지 않습니다.`);
        let status = result.status; let error = result.error ?? null;
        if (status === 'completed') try { ({ speech: speechSchema, receive: receiveSchema, director: directorSchema, evaluation: evaluationSchema }[call.kind]).parse(JSON.parse(result.output)); } catch (e) { status = 'failed'; error = err(e); }
        this.store.patch('invocations', call.id, { status, turnId: result.turnId, output: result.output, error, completedAt: now(), metadata: { ...call.metadata, reconciled: true }, durationMs: null });
      }
      if (this.run(id).status === 'stopped') throw new Error('상태 확인 중 묶음이 중단되었습니다.');
      this.store.patch('runs', id, { status: 'queued', pauseRequested: false, stepRemaining: step ? 1 : null, error: null }); this.pump();
    } finally { this.resuming.delete(id); }
  }
  async stop(id: string) {
    const run = this.run(id);
    if (['completed', 'stopped'].includes(run.status)) return;
    this.store.patch('runs', id, { status: 'stopped', completedAt: this.workers.has(id) ? null : now(), pausedAt: null, pausedMs: run.pausedMs + (run.pausedAt ? Date.now() - Date.parse(run.pausedAt) : 0) });
    for (const controller of this.aborts.get(id) ?? []) controller.abort();
    this.changed(id);
  }
  private appendEvent(id: string, text: string) {
    const all = this.store.list('utterances', id);
    this.append(id, { id: randomUUID(), runId: id, sequence: all.length + 1, speechIndex: null, kind: 'event', speakerId: '__narrator__', speakerName: '상황', speech: text, action: '', createdAt: now(), invocationId: null, deliveryCompletedAt: null, deliveryMs: null });
    this.store.event(id, null, 'narrator/event', { text });
  }
  async inject(id: string, text: string) {
    const run = this.run(id); if (run.status !== 'paused' || this.workers.has(id)) throw new Error('상황은 일시정지가 완료된 묶음에 투입하세요.');
    if (!text.trim() || text.length > 100_000) throw new Error('상황 내용은 1~100,000자여야 합니다.');
    this.store.transaction(() => this.appendEvent(id, text));
    const worker = (async () => { await this.sessions(id); await this.flush(id); })(); this.workers.set(id, worker);
    try { await worker; } finally { this.workers.delete(id); this.changed(id); this.pump(); }
  }
  review(findingId: string, review: 'unreviewed' | 'confirmed' | 'dismissed', note: string) { const f = this.store.patch('findings', findingId, { review, note }); this.changed(f.runId); return f; }
  detail(id: string): RunDetail {
    const run = this.run(id); const utterances = this.store.list('utterances', id), invocations = this.store.list('invocations', id), findings = this.store.list('findings', id), evaluations = this.store.list('evaluations', id), receipts = this.store.list('receipts', id);
    const count = utterances.filter(u => u.kind === 'speech').length; const evaluated = new Set<number>();
    const repetitionEvaluated = new Set<number>();
    for (const e of evaluations.filter(e => e.status === 'completed')) for (let i = e.from; i <= e.to; i++) evaluated.add(i);
    for (const e of evaluations.filter(e => e.status === 'completed')) {
      const version = String(invocations.find(c => c.id === e.invocationId)?.metadata.promptVersion ?? '').match(/^npc-lab\/(\d+)/);
      if (version && Number(version[1]) >= 2) for (let i = e.from; i <= e.to; i++) repetitionEvaluated.add(i);
    }
    const issues = findings.filter(f => f.review !== 'dismissed' && f.verdict === 'issue');
    const issueUtterances = new Set(issues.map(f => f.utteranceId)); const total = aggregate(invocations);
    const end = run.completedAt ? Date.parse(run.completedAt) : Date.now();
    return { run, utterances, invocations, findings, evaluations, receipts, summary: {
      ...total, speechCount: count, pendingReceipts: receipts.filter(r => r.status !== 'delivered').length,
      byKind: Object.fromEntries((['speech', 'receive', 'director', 'evaluation'] as CallKind[]).map(k => [k, aggregate(invocations.filter(c => c.kind === k))])),
      tokensPerSpeech: count && total.tokens.totalTokens !== null ? total.tokens.totalTokens / count : null,
      evaluatedUtterances: evaluated.size, evaluationFailures: evaluations.filter(e => e.status === 'failed').length,
      firstIssue: utterances.find(u => issueUtterances.has(u.id))?.speechIndex ?? null,
      issueRate: evaluated.size ? issueUtterances.size / evaluated.size : null,
      categories: Object.fromEntries([...new Set(findings.map(f => f.category))].map(k => [k, issues.filter(f => f.category === k).length])),
      confirmedIssues: issues.filter(f => f.review === 'confirmed').length,
      quality: qualityMetrics(run.spec, utterances, findings, repetitionEvaluated.size),
      elapsedMs: run.startedAt ? end - Date.parse(run.startedAt) : 0, activeMs: run.activeMs + (this.activeStarts.has(id) ? performance.now() - this.activeStarts.get(id)! : 0),
      timingComplete: run.timingComplete ?? true,
      pausedMs: run.pausedMs + (run.pausedAt && !run.completedAt ? Date.now() - Date.parse(run.pausedAt) : 0),
    } };
  }
  async idle() { while (this.workers.size || this.store.list('runs').some(r => r.status === 'queued')) { await Promise.allSettled([...this.workers.values()]); await new Promise(r => setTimeout(r, 5)); } }
  async close() { this.closing = true; for (const set of this.aborts.values()) for (const c of set) c.abort(); await Promise.allSettled([...this.workers.values()]); await this.adapter.close(); }
}
