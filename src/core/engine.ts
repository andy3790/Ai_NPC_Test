import { buildRunSummary, matchesProvider, toRunListItem, withRunTiming } from './summary.js';
import { simulationEffort } from '../shared/role-models.js';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Adapter } from '../adapters/types.js';
import { Store } from './store.js';
import { SessionCleanup } from './session-cleanup.js';
import { ACTOR_CONTEXT_VERSION, actorRecall, checkDialogue, establishedConversation, LANGUAGE_CHECK_VERSION, languageRepairSchema, priorDisclosures } from './actor-context.js';
import { CONVERSATION_MEMORY_VERSION, DIALOGUE_MEMORY_VERSION, TOPIC_CLOSURE_VERSION, checkProspectiveClaim, checkQuietDisclosure, compactDiscussion, conversationMemory, recallsPlans, rememberSource, usesSourceReferences, withMemoryCheckpoint } from './conversation-memory.js';
import { authoredObservation, SCENE_OBSERVATION_VERSION } from './scene-observation.js';
import { readSocialChoice, rememberSocialChoice, repairReactionLanguage, socialTurn, SOCIAL_REACTION_VERSION, withReactionBeat, withSocialChoice } from './social-reaction.js';
import { WORLD_CONTEXT_VERSION, worldRequestContext } from './world-context.js';
import { CHARACTER_PERFORMANCE } from '../shared/character-performance.js';
import { committedPerformance, performTurn, withPortrayal, lacksVoice, parseSpeechOutput, SPARSE_VOICE_VERSION, sparseFollowUp, withSpeechUnits } from './character-performance.js';
import { emptyUsage, UsageTracker } from './metrics.js';
import { evaluationPrompt, persona, PROMPT_VERSION, publicMessage, receiverBatchPrompt, receiverPrompt, speakerPrompt } from './prompts.js';
import { receiveBarriers, RECEIVE_DELIVERY_VERSION } from './receive-delivery.js';
import { CURRENT_DIALOGUE_PROMPT, LEGACY_DIALOGUE_PROMPT } from '../shared/dialogue-policy.js';
import { WORLD_PROMPT_VERSION, LEGACY_WORLD_PROMPT } from '../shared/world-policy.js';
import { dialogueEnding, isSilentTurn } from './dialogue-idle.js';
import { directorSchema, evaluationSchema, experimentSchema, outputSchemas, receiveSchema, speechSchema, environmentMode, isAiEnvironment, responseValidator, type ExperimentSpec, type ModelConfig } from '../shared/schema.js';
import { receives } from './perception.js';
import { audienceNpcIds } from './perception.js';
import type { Audience } from '../shared/spatial-schema.js';
import type { SimulationHost } from './simulation-host.js';
import { runSpatial } from './spatial-runner.js';
import { clockObservations, nextClockBoundary, nextIdleDeadline } from './scene-clock.js';
import { applySceneDecision, sceneDecision, sceneTime, sceneTurn, SCENE_FLOW_VERSION, timeCut, usesSceneFlowV2, waitingActors, withSceneChoice } from './scene-flow.js';
import { WitnessMemory, witnessVersionFor } from './witness-memory.js';
import { causalProposalSchema, nextSituationCheck } from './situations.js';
import { ARRIVAL_CONTRACT_VERSION, groundedEvents, spatialChoiceContract, spatialContract, SPATIAL_CHOICE_VERSION, SPATIAL_CONTRACT_VERSION, WORLD_CONTRACT_VERSION } from './spatial-contract.js';
import { z } from 'zod';
import { advanceSingleRoomSituations } from './single-room-situations.js';
import { worldFactSchema, worldOutputSchema } from '../shared/world-schema.js';
import { applyWorldOutput, deadlineOutput, initialWorldState, priorityWorldSpeaker, worldPrompt, worldResponseContract } from './world.js';
import { managerState, managerWorld } from './spatial-prompts.js';
import { worldPromptVersion, worldPolicies } from './world-policies.js';
import type { ApiCredential, CallKind, DeliveryReceipt, InvocationMetrics, NpcSession, Run, RunDetail, RunListItem, RunRecords, RunSummary, Utterance } from '../shared/types.js';
import { progression, progressionPrompt, resolveAction } from './progression.js';
import { repetitionMetrics } from './quality.js';
import { APP_VERSION } from '../shared/version.js';
import { directorPrompt } from './director.js';
import './load-model-catalog.js';

const now = () => new Date().toISOString();
const err = (e: unknown) => e instanceof Error ? e.message : String(e);
class Slots {
  active = 0; waiters: (() => void)[] = []; limit = 2;
  async enter() { if (this.active >= this.limit) await new Promise<void>(r => this.waiters.push(r)); else this.active++; }
  private drain() { while (this.active < this.limit && this.waiters.length) { this.active++; this.waiters.shift()!(); } }
  setLimit(limit: number) { this.limit = limit; this.drain(); }
  leave() { this.active--; this.drain(); }
}
export class Engine extends EventEmitter {
  private witnesses=new Map<string,WitnessMemory>();
  private workers = new Map<string, Promise<void>>();
  private aborts = new Map<string, Set<AbortController>>();
  private slots = new Slots(); private closing = false;
  private activeStarts = new Map<string, number>();
  private summaries = new Map<string, { revision: number; summary: RunSummary }>();
  private resuming = new Set<string>();
  private sessionCleanup: SessionCleanup;
  constructor(public store: Store, public adapter: Adapter, public dataDir: string) {
    super();
    this.sessionCleanup = new SessionCleanup(store, adapter, dataDir);
    for (const run of store.list('runs')) if (['running', 'queued'].includes(run.status)) store.patch('runs', run.id, { status: 'paused', pausedAt: now(), timingComplete: run.status === 'running' ? false : run.timingComplete, error: '서버 재시작: 재개 전에 미확정 호출을 확인합니다.' });
    for (const call of store.list('invocations')) {
      if (call.status === 'running') store.patch('invocations', call.id, { status: 'uncertain', error: '서버 재시작으로 완료 확인 필요' });
      if (call.status === 'queued') store.patch('invocations', call.id, { status: 'cancelled', error: '전송 전 서버 재시작', completedAt: now() });
    }
  }
  private changed(runId: string) { this.emit('change', { runId, at: now() }); }
  run(id: string) { const r = this.store.get('runs', id); if (!r) throw new Error('대화 묶음이 없습니다.'); return r; }
  async validate(spec: unknown, credential?: ApiCredential): Promise<ExperimentSpec> {
    const parsed = experimentSchema.parse(spec); const models = await this.adapter.models(credential);
    const check = (config: ModelConfig) => {
      const model = models.find(m => m.id === config.model);
      if (!model || !model.efforts.includes(config.effort)) throw new Error(`사용할 수 없는 모델·추론 조합: ${config.model} / ${config.effort}`);
      if (!simulationEffort(config.effort)) throw new Error(`독립 NPC 실험의 추론 강도는 high 이하입니다: ${config.effort}`);
    };
    for (const v of parsed.variants) for (const c of parsed.scenario.characters) check({ model: c.model ?? v.model ?? parsed.scenario.defaults.model, effort: c.effort ?? v.effort ?? parsed.scenario.defaults.effort });
    if (parsed.evaluation.enabled) check(parsed.evaluation);
    if (parsed.variants.some(v => v.turnPolicy === 'director')) check(parsed.director);
    if (parsed.variants.some(v => isAiEnvironment(parsed, v))) check(parsed.worldEngine!);
    if (parsed.variants.some(v => v.eventGeneration)) check(parsed.eventGenerator!);
    return parsed;
  }
  async create(input: unknown, start = true, credential?: ApiCredential) {
    const spec = await this.validate(input, credential); const experimentId = randomUUID(); const runs: Run[] = [];
    for (const sourceVariant of spec.variants) for (let repetition = 1; repetition <= spec.repetitions; repetition++) {
      // Pin the resolved policy before any session is created, including paused runs.
      const variant = { ...sourceVariant, dialoguePromptVersion: sourceVariant.dialoguePromptVersion ?? CURRENT_DIALOGUE_PROMPT,
        characterPerformanceVersion: sourceVariant.characterPerformanceVersion ?? CHARACTER_PERFORMANCE,
        ...(environmentMode(spec, sourceVariant) === 'ai' ? { worldPromptVersion: sourceVariant.worldPromptVersion ?? WORLD_PROMPT_VERSION } : {}) };
      const context = {conversationMemoryVersion:environmentMode(spec,variant)==='off' ? DIALOGUE_MEMORY_VERSION : CONVERSATION_MEMORY_VERSION,
        sceneObservationVersion:SCENE_OBSERVATION_VERSION, topicClosureVersion:TOPIC_CLOSURE_VERSION, sceneFlowVersion:SCENE_FLOW_VERSION,
        witnessMemoryVersion:witnessVersionFor(environmentMode(spec,variant)!=='off'),
        ...(variant.characterPerformanceVersion===CHARACTER_PERFORMANCE && {socialReactionVersion:SOCIAL_REACTION_VERSION}),
        ...(variant.characterPerformanceVersion===CHARACTER_PERFORMANCE && spec.scenario.characters.some(lacksVoice) && {sparseVoiceVersion:SPARSE_VOICE_VERSION}),
        ...(this.adapter.name === 'openai' && { npcContextVersion: ACTOR_CONTEXT_VERSION,
        ...(isAiEnvironment(spec, variant) && { worldContextVersion: WORLD_CONTEXT_VERSION }) })};
      const snapshotHash = createHash('sha256').update(JSON.stringify({ spec, variant, repetition, promptVersion: PROMPT_VERSION, ...context })).digest('hex');
      const run: Run = { id: randomUUID(), experimentId, name: `${spec.name} · ${variant.label} · #${repetition}`, variant, repetition, spec, snapshotHash,
        status: start ? 'queued' : 'paused', error: null, createdAt: now(), startedAt: null, completedAt: null, activeMs: 0, pausedMs: 0, pausedAt: start ? null : now(), timingComplete: true,
        sessions: {}, helperSessions: {}, lastSpeakerId: null, nextSpeakerId: null, evaluatedThrough: 0, appliedEvents: [], stepRemaining: null, pauseRequested: false,
        revisions: 0, adapter: this.adapter.name, appVersion: APP_VERSION, cliVersion: this.adapter.version, promptVersion: PROMPT_VERSION,
        ...context, ...(this.adapter.name === 'openai' ? { apiCredential: credential ?? { source: 'environment' as const } } : {}) };
      this.store.put('runs', run); runs.push(run); this.changed(run.id);
    }
    this.store.setting('lastSpec', spec); this.pump(); return { experimentId, runs };
  }
  private refreshCallLimit() {
    const limits = [...this.workers.keys()].map(id => this.run(id).spec.maxConcurrentCalls);
    this.slots.setLimit(limits.length ? Math.min(...limits) : 2);
  }
  private startWorker(id: string, task: () => Promise<void>) {
    if (this.workers.has(id)) throw new Error('현재 진행 중인 요청이 끝난 뒤 실행하세요.');
    // Register before any asynchronous work can request a call slot. Manual
    // evaluations and event delivery participate in the same global limit.
    const worker = Promise.resolve().then(task).finally(async () => {
      try { await this.sessionCleanup.run(id); }
      finally { this.workers.delete(id); this.witnesses.delete(id); this.refreshCallLimit(); this.changed(id); this.pump(); }
    });
    this.workers.set(id, worker); this.refreshCallLimit(); this.changed(id);
    return worker;
  }
  private pump() {
    if (this.closing) return;
    for (const run of this.store.list('runs').filter(r => r.status === 'queued')) {
      if (this.workers.has(run.id)) continue;
      const active = [...this.workers.keys()].map(id => this.run(id));
      if (active.filter(r => r.experimentId === run.experimentId).length >= run.spec.concurrentRuns || active.length >= 16) continue;
      const pausedMs = run.pausedMs + (run.pausedAt ? Date.now() - Date.parse(run.pausedAt) : 0);
      this.store.patch('runs', run.id, { status: 'running', startedAt: run.startedAt ?? now(), pausedAt: null, pausedMs, error: null });
      this.startWorker(run.id, () => this.workWithRepairs(run.id).catch(e => {
        if (this.run(run.id).status !== 'stopped') this.store.patch('runs', run.id, { status: 'paused', pausedAt: now(), error: err(e) });
      }));
    }
  }
  private async workWithRepairs(id: string) {
    for (;;) {
      const before = this.store.db.prepare('SELECT MAX(rowid) AS n FROM invocations WHERE run_id=?').get(id);
      try { await this.work(id); return; }
      catch (error) {
        const run = this.run(id);
        if (!run.npcContextVersion || run.status !== 'running' || this.closing || run.pauseRequested) throw error;
        // A local schema/state rejection of a billed, terminal answer is safe to
        // replay. Ambiguous transport, auth, interrupted and unbilled calls pause.
        const rows = this.store.db.prepare("SELECT data FROM invocations WHERE run_id=? AND rowid>? AND json_extract(data,'$.status')!='completed' ORDER BY rowid").all(id, Number(before?.n ?? 0));
        const bad = rows.map(r => JSON.parse(String(r.data)) as InvocationMetrics);
        if (!bad.length || bad.some(c => c.status !== 'failed' || !c.turnId || c.attempt >= 3 ||
          (!c.output && !c.error?.includes('max_output_tokens')))) throw error;
        this.store.event(id, null, 'run/repairing_output', { operationKeys: bad.map(c => c.operationKey) });
      }
    }
  }
  private async sessions(id: string) {
    for (const c of this.run(id).spec.scenario.characters) {
      const run = this.run(id); if (Object.hasOwn(run.sessions, c.id)) { await this.restoreSession(id, 'sessions', c.id, run.sessions[c.id]); continue; }
      const config = { model: c.model ?? run.variant.model ?? run.spec.scenario.defaults.model, effort: c.effort ?? run.variant.effort ?? run.spec.scenario.defaults.effort };
      const instructions = persona(run.spec, c, { ...run.variant,
        dialoguePromptVersion: run.variant.dialoguePromptVersion ?? LEGACY_DIALOGUE_PROMPT },!!run.sceneObservationVersion,!!run.sceneFlowVersion);
      const threadId = await this.adapter.createSession(config, instructions, join(this.dataDir, 'sessions', id, c.id), run.apiCredential);
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
      const threadId = await this.adapter.createSession(session.config, session.instructions, join(this.dataDir, 'sessions', id, key), this.run(id).apiCredential);
      const restored = { ...session, threadId };
      this.store.patch('runs', id, { [collection]: { ...this.run(id)[collection], [key]: restored } });
      this.store.event(id, null, 'session/recreated_empty', { sessionId: session.id, oldThreadId: session.threadId, newThreadId: threadId, reason: 'Codex did not persist a never-invoked thread' });
      return restored;
    }
  }
  private async helper(id: string, key: string, config: ModelConfig, instructions: string, fresh = false): Promise<NpcSession> {
    const helpers = this.run(id).helperSessions;
    const old = helpers[key];
    const deleted = old && ['deleted', 'missing'].includes(this.run(id).sessionCleanup?.[old.threadId]?.status ?? '');
    if (!fresh && old && !deleted) return this.restoreSession(id, 'helperSessions', key, old);
    if (fresh && old) await this.sessionCleanup.beforeReplacement(id, old.threadId);
    const threadId = await this.adapter.createSession(config, instructions, join(this.dataDir, 'sessions', id, key), this.run(id).apiCredential);
    const session = { id: randomUUID(), characterId: key, threadId, config, instructions };
    this.store.patch('runs', id, { helperSessions: { ...this.run(id).helperSessions, [key]: session } }); return session;
  }
  private priorInvocation(id: string, operationKey: string) {
    const previous = this.store.attempts(id, operationKey).at(-1);
    if (previous && ['uncertain', 'running'].includes(previous.status)) throw new Error(`미확정 호출 ${previous.id}: 자동 재전송하지 않습니다. 재개하여 상태를 확인하세요.`);
    return previous;
  }
  private async direct(id: string, key: string, operationKey: string, prompt: ReturnType<typeof directorPrompt>) {
    // Check before creating a thread: completed decisions survive commit failures,
    // and ambiguous decisions must never be sent twice.
    const previous = this.priorInvocation(id, operationKey);
    if (previous?.status === 'completed') return previous;
    const session = await this.helper(id, key, this.run(id).spec.director, prompt.instructions, true);
    try { return await this.invoke(id, 'director', session, operationKey, prompt.input, prompt.metadata, prompt.outputSchema); }
    finally { await this.sessionCleanup.run(id, session.threadId); }
  }
  private async speak(id: string, session: NpcSession, key: string, input: string, metadata: Record<string, unknown>, history: Utterance[]) {
    const run = this.run(id);
    const version = run.variant.characterPerformanceVersion;
    const characters = run.spec.scenario.characters;
    const slot = characters.findIndex(c => c.id === session.characterId);
    const prompt = JSON.parse(input);
    const fresh = new Set<string>((prompt.messages ?? []).map((u: {id:string}) => u.id));
    const memory = run.conversationMemoryVersion
      ? conversationMemory(history,session.characterId,session.setAsideSequences ?? [],fresh,run.conversationMemoryVersion,
        characters[slot].goals,Boolean(prompt.localContext?.ongoingActivity || prompt.localContext?.transit || prompt.environment),run) : undefined;
    const spatial = metadata.outputType === 'spatialSpeech' && run.npcContextVersion
      ? spatialChoiceContract(prompt.localContext, session.characterId) : undefined;
    if (spatial) metadata = { ...metadata, spatialChoiceVersion: SPATIAL_CHOICE_VERSION };
    if (run.npcContextVersion && !memory?.quiet) {
      prompt.earlierObservations = actorRecall(history, session.characterId, fresh,!!run.sceneObservationVersion).filter(u => !memory?.omit.has(u.sequence));
      const established = ['npc-context/3', ACTOR_CONTEXT_VERSION].includes(run.npcContextVersion) ? establishedConversation(history,session.characterId).filter(u => !memory?.omit.has(u.sequence)) : [];
      if (established.length) prompt.alreadyHeard = established;
      prompt.continuity = 'earlierObservations는 이미 오간 말과 확정된 결과다. 현재 일어나는 일은 messages와 현재 위치에서 확인한다. 상대가 이미 들은 자기소개나 결정을 다시 설명할 필요가 없다.';
      if (established.length) prompt.continuity += ' alreadyHeard의 말을 처음 듣는 반응은 시간상 맞지 않는다. 지난 합의는 이번에 실제로 달라진 점이 있을 때 다시 다룬다.';
    }
    const retainListeners=run.conversationMemoryVersion===DIALOGUE_MEMORY_VERSION;
    if (run.npcContextVersion === ACTOR_CONTEXT_VERSION && (retainListeners || !memory?.quiet)) {
      const shared=priorDisclosures(history,characters[slot],characters).filter(u=>retainListeners || !memory?.omit.has(u.sequence));
      if (shared.length) prompt.alreadyTold=shared;
    }
    if (memory) {
      if (retainListeners && memory.context.quiet && prompt.alreadyTold)
        memory.context.quiet+=' alreadyTold에 적힌 사람에게는 그 소식이 이미 전해졌다.';
      if (Object.keys(memory.context).length) {
        const available=[...(prompt.messages ?? []),...(prompt.alreadyTold ?? []),...(prompt.alreadyHeard ?? []),...(prompt.earlierObservations ?? [])];
        prompt.conversationMemory=!memory.ordinaryRecall && usesSourceReferences(run.topicClosureVersion)
          ? compactDiscussion(memory.context,available.map(source=>source.sequence)) : memory.context;
      }
      metadata = {...metadata,conversationMemoryVersion:run.conversationMemoryVersion, omittedRecall:memory.omit.size,
        ...(memory.offered.length && {memoryOffers:memory.offered})};
    }
    let schema: {properties?:object; required?:string[]} = spatial ?? (metadata.outputType === 'spatialSpeech' ? outputSchemas.spatialSpeech :
      environmentMode(run.spec, run.variant) === 'rules' ? outputSchemas.progressSpeech : outputSchemas.speech);
    if (version && version !== 'off') {
      const turn = performTurn(version, characters[slot], slot, session, history);
      prompt.characterPerformance = turn.context;
      if (turn.context.earlierWords && memory && (memory.quiet || memory.omit.has(history.find(u => u.id===turn.context.earlierWords?.id)?.sequence ?? -1)))
        delete prompt.characterPerformance.earlierWords;
      metadata = {...metadata,...turn.metadata};
      if (turn.select) schema = withPortrayal(schema,turn.fixedPhrasing);
      const familiar=Boolean(memory?.context.setAside?.length || ((!run.topicClosureVersion || memory?.ordinaryRecall) && memory?.context.repeatedExchange));
      const followUp=run.sparseVoiceVersion && !prompt.localContext?.ongoingActivity && !prompt.environment &&
        sparseFollowUp(characters[slot],slot,history,familiar);
      if (followUp) {
        schema=withSpeechUnits(schema,followUp.units);
        prompt.characterPerformance.followUp=followUp.cadence;
        metadata={...metadata,sparseVoiceVersion:SPARSE_VOICE_VERSION,speechUnits:followUp.units};
      }
    }
    if (run.socialReactionVersion) {
      const reaction=socialTurn(characters[slot],characters,history,session.socialMemory ?? [],prompt.localContext?.nearbyNpcs,
        run.socialReactionVersion,run.spec.scenario.situation);
      if (reaction) {
        const target=reaction.peers.find(p=>p.id===reaction.beat?.peerId);
        const peers=run.socialReactionVersion==='social-reaction/3' && target ? [target.id] : reaction.peers.map(p=>p.id);
        prompt.socialReaction=reaction;
        schema=withSocialChoice(schema,peers);
        metadata={...metadata,socialReactionVersion:run.socialReactionVersion,socialPeers:peers};
        if (target && environmentMode(run.spec,run.variant)==='off' && !metadata.speechUnits) {
          schema=withReactionBeat(schema);
          metadata.socialBeat=true;
          prompt.instruction=run.socialReactionVersion==='social-reaction/2'
            ? '지금은 socialReaction.beat에 대한 첫 반응 한 번이다. 본인의 대꾸 하나 또는 눈에 보이는 본인 행동 하나를 reaction에 고른다. 둘 다 하지 않아도 된다. 그 다음에 할 일은 다음 차례가 온 뒤의 일이다.'
            : '지금 반응의 상대는 '+target.name+'이다. 본인이 고른 socialChoice를 실제 reaction에 옮긴다. 시비를 걸었다면 그 사람한테 던질 말이나 몸짓 하나에서 멈춘다. 대화를 끊었다면 그만두는 순간을 보여 준다. 받아넘기고 싶으면 평소처럼 고른다. 당장 든 감정을 본인답게 내고 상대의 다음 반응은 남겨 둔다.';
        }
      }
    }
    if (run.sceneFlowVersion) {
      const flow=sceneTurn(run,session,history);
      const sources=flow.sources.map(source=>source.sequence);
      prompt.sceneNow=flow.context;
      schema=withSceneChoice(schema,sources);
      metadata={...metadata,sceneFlowVersion:run.sceneFlowVersion,sceneSources:sources,sceneSeconds:sceneTime(run)};
    }
    const through=history.at(-1)?.sequence ?? 0;
    const place=prompt.localContext?.location?.id ?? null;
    let index=this.witnesses.get(id);
    if (run.witnessMemoryVersion && !index) {
      index=new WitnessMemory(characters,run.spec.scenario.spatial?.locations,run.witnessMemoryVersion);
      this.witnesses.set(id,index);
    }
    const view=index?.observe(history).view(session.characterId,sceneTime(run));
    if (index && view) {
      const context=index.context(view,place);
      if (context) prompt.witnessed=context;
      metadata={...metadata,witnessMemoryVersion:run.witnessMemoryVersion,witnessThrough:through,witnessPlace:place,
        heardQuestions:view.questions.length,verifiedChecks:view.checks.length};
    }
    const call=await this.invoke(id, 'speech', session, key, JSON.stringify(prompt), metadata,
      withMemoryCheckpoint(schema,memory?.offered ?? []), history);
    if (!index || !view || !call.metadata.witnessMemoryVersion || call.metadata.witnessEdit) return call;
    // A completed but uncommitted response belongs to its original pre-turn
    // world, even if an observer received a new signal during recovery.
    const cutoff=Number(call.metadata.witnessThrough);
    const atDecision=cutoff===through ? view : new WitnessMemory(characters,run.spec.scenario.spatial?.locations,run.witnessMemoryVersion)
      .observe(history.filter(u=>u.sequence<=cutoff)).view(session.characterId,Number(call.metadata.sceneSeconds));
    const edit=index.edit(atDecision,session.characterId,call.metadata.witnessPlace as string|null,parseSpeechOutput(call));
    return edit ? this.store.patch('invocations',call.id,{metadata:{...call.metadata,witnessEdit:edit}}) : call;
  }
  private async invoke(id: string, kind: CallKind, session: NpcSession, operationKey: string, input: string, metadata: Record<string, unknown> = {}, requestedOutputSchema?: object, history?: Utterance[]) {
    const previous = this.priorInvocation(id, operationKey);
    if (previous?.status === 'completed') return previous;
    const run = this.run(id);
    const originalInput = input;
    const worldContext = kind === 'environment' && run.worldContextVersion === WORLD_CONTEXT_VERSION
      ? worldRequestContext(input, run.worldState, history ?? this.store.list('utterances', id), previous?.error) : undefined;
    const independent = !!run.npcContextVersion && (kind === 'speech' || kind === 'receive');
    if (worldContext) {
      input = JSON.stringify({ ...worldContext.scene, ...worldContext.tick });
      metadata = { ...metadata, worldContextVersion: run.worldContextVersion };
    } else if (independent && previous?.turnId && previous.output && previous.error && !previous.error.includes('max_output_tokens')) {
      input = JSON.stringify({ ...JSON.parse(input), previousFailure: previous.error.slice(0, 1500) });
    } else if (previous?.turnId && previous.threadId === session.threadId && previous.metadata.inputRetained !== false) {
      // The persistent session already contains the failed attempt and its full input.
      input = JSON.stringify({ task: JSON.parse(input).task, previousFailure: previous.error?.slice(0, 5000), instruction: '바로 이전 요청은 실패하거나 형식이 잘못되었습니다. 해당 호출의 결과는 아직 공개·적용되지 않았습니다. previousFailure는 이전 결과가 거부된 이유입니다. 이미 전달된 이전 요청의 내용을 사용하여 그 요청만 다시 완료하세요. 새 공개 발언이나 세계 설정을 입력한 것이 아닙니다. 지정된 JSON 형식만 반환하세요.' });
    }
    const format = metadata.outputType as keyof typeof outputSchemas | undefined;
    const checkArrivals=usesSceneFlowV2(run.sceneFlowVersion) && format==='spatialResolution';
    const spatialFormat = run.npcContextVersion && run.npcContextVersion !== 'npc-context/1' && run.worldState?.spatial && (format === 'spatialPlan' || format === 'spatialResolution')
      ? spatialContract(String(metadata.phase),run.spec,run.worldState,metadata.sourceUtteranceIds as string[],history ?? [],checkArrivals) : undefined;
    if (spatialFormat || kind === 'environment' && !format && run.npcContextVersion && run.npcContextVersion !== 'npc-context/1')
      metadata = { ...metadata, worldContractVersion:checkArrivals ? ARRIVAL_CONTRACT_VERSION : spatialFormat ? SPATIAL_CONTRACT_VERSION : WORLD_CONTRACT_VERSION };
    const proposalSchema=kind==='event_generation' && Array.isArray(metadata.causeSources) && metadata.causeSources.length
      ? causalProposalSchema(metadata.causeSources) : undefined;
    const baseSchema = requestedOutputSchema ?? spatialFormat ?? proposalSchema ?? (format ? outputSchemas[format] : kind === 'speech' && environmentMode(run.spec, run.variant) === 'rules' ? outputSchemas.progressSpeech : outputSchemas[kind]);
    const repairLanguage = metadata.socialBeat ? repairReactionLanguage : languageRepairSchema;
    const languageRepair = independent && kind === 'speech' && previous?.error
      ? repairLanguage(baseSchema,session.instructions+' '+input,previous.error) : undefined;
    const outputSchema = languageRepair ?? baseSchema;
    if (languageRepair) metadata = { ...metadata, languageRepair: true };
    const call: InvocationMetrics = {
      id: randomUUID(), experimentId: run.experimentId, runId: id, variantId: run.variant.id, repetition: run.repetition,
      kind, characterId: ['speech', 'receive'].includes(kind) ? session.characterId : null, operationKey, attempt: (previous?.attempt ?? 0) + 1, retryOf: previous?.id ?? null,
      threadId: session.threadId, turnId: null, sourceUtteranceId: (metadata.sourceUtteranceId as string) ?? null, utteranceId: null,
      model: session.config.model, effort: session.config.effort, actualModel: null, deliveryMode: run.variant.deliveryMode, memoryMode: run.variant.memoryMode,
      environmentMode: environmentMode(run.spec, run.variant),
      queuedAt: now(), startedAt: null, firstOutputAt: null, completedAt: null, queueMs: null, firstOutputMs: null, durationMs: null,
      status: 'queued', usage: emptyUsage(), usageStatus: 'not_started', input, output: '', error: null,
      metadata: { ...metadata, adapter: run.adapter, appVersion: run.appVersion, cliVersion: run.cliVersion,
        promptVersion: run.promptVersion ?? null, runtimePromptVersion: PROMPT_VERSION,
        ...((kind === 'speech' || kind === 'receive') && run.npcContextVersion && { npcContextVersion: run.npcContextVersion }),
        ...((kind==='speech' || kind==='receive') && run.sceneObservationVersion && {sceneObservationVersion:run.sceneObservationVersion}),
        ...(kind==='speech' && run.topicClosureVersion && {topicClosureVersion:run.topicClosureVersion}),
        ...(kind === 'speech' && run.npcContextVersion && run.npcContextVersion !== 'npc-context/1' && {languageCheckVersion:LANGUAGE_CHECK_VERSION}),
        dialoguePromptVersion: run.variant.dialoguePromptVersion ?? null,
        worldPromptVersion: kind === 'environment' ? worldPromptVersion(session.instructions) : null,
        outputSchemaSha256: createHash('sha256').update(JSON.stringify(outputSchema)).digest('hex'),
        instructionsSha256: createHash('sha256').update(session.instructions).digest('hex') },
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
        result = await this.adapter.turn({ threadId: session.threadId, config: session.config, input, worldContext, independent, outputSchema, clientMessageId: call.id, timeoutMs: run.spec.timeoutMs }, event => {
          // Late usage events must preserve fields committed after the turn completed.
          Object.assign(call, this.store.get('invocations', call.id));
          this.store.event(id, call.id, event.method, event.params);
          if (event.method === 'turn/accepted' || event.method === 'turn/started') call.turnId = event.params.turnId ?? event.params.turn?.id;
          if (event.method === 'item/agentMessage/delta' && !call.firstOutputAt) { call.firstOutputAt = now(); call.firstOutputMs = performance.now() - begin; }
          if (event.method === 'thread/tokenUsage/updated') { tracker.update(event.params); const result = tracker.result(); call.usage = result.usage; call.usageStatus = result.status; }
          if (event.method === 'response/usage') { tracker.report(event.params.usage); const usage = tracker.result(); call.usage = usage.usage; call.usageStatus = usage.status; }
          if (event.method === 'model/rerouted') call.actualModel = event.params.toModel;
          if (event.method === 'model/resolved') call.actualModel = event.params.model;
          if (event.method === 'item/started' && event.params.item?.type === 'contextCompaction') call.metadata.compactions = Number(call.metadata.compactions ?? 0) + 1;
          this.store.put('invocations', call); this.changed(id);
        }, controller.signal);
      } finally { set.delete(controller); }
      const usage = tracker.result();
      if (result.inputRetained !== undefined) call.metadata.inputRetained = result.inputRetained;
      Object.assign(call, { turnId: result.turnId || call.turnId, output: result.output, status: result.status, error: result.error ?? null,
        completedAt: now(), durationMs: performance.now() - begin, usage: usage.usage, usageStatus: usage.status });
      if (call.status === 'completed') {
        try { this.validateResponse(run,call,originalInput,history); }
        catch (e) { call.status = 'failed'; call.error = `출력 형식 오류: ${err(e)}`; }
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
  private validateResponse(run: Run, call: InvocationMetrics, originalInput: string, history?: Utterance[]) {
    const parsed=call.kind==='speech' ? parseSpeechOutput(call) : JSON.parse(call.output);
    responseValidator(call.kind,call.metadata.outputType).parse(parsed);
    if (call.kind!=='speech' || !call.characterId) return;
    if (Array.isArray(call.metadata.sceneSources)) sceneDecision(parsed,call.metadata.sceneSources);
    if (call.metadata.socialReactionVersion && Array.isArray(call.metadata.socialPeers)) readSocialChoice(parsed.socialChoice,call.metadata.socialPeers);
    if (recallsPlans(run.conversationMemoryVersion)) {
      const prompt=JSON.parse(originalInput);
      const prospect=prompt.conversationMemory?.prospective;
      if (prospect) {
        const character=run.spec.scenario.characters.find(c=>c.id===call.characterId)!;
        checkProspectiveClaim(parsed.speech,prospect,[character.identity,character.memories,character.knowledge].join(' '));
      }
      if (run.conversationMemoryVersion===DIALOGUE_MEMORY_VERSION && prompt.conversationMemory?.quiet && prompt.alreadyTold)
        checkQuietDisclosure(parsed.speech,prompt.alreadyTold,run.spec.scenario.characters.filter(c=>c.id!==call.characterId).map(c=>c.name));
    }
    if (run.npcContextVersion && run.npcContextVersion!=='npc-context/1')
      checkDialogue(parsed.speech,parsed.action,history ?? this.store.list('utterances',run.id),call.characterId,
        (run.sessions[call.characterId]?.instructions ?? '')+' '+call.input);
  }
  private pending(id: string, characterId?: string) { return this.store.list('receipts', id).filter(r => r.status !== 'delivered' && (!characterId || r.characterId === characterId)); }
  private completeDelivery(id: string, u: Utterance, receipts = this.store.list('receipts', id)) {
    const all = receipts.filter(r => r.utteranceId === u.id);
    if (all.every(r => r.status === 'delivered') && !u.deliveryCompletedAt) {
      this.store.patch('utterances', u.id, { deliveryCompletedAt: now(), deliveryMs: Date.now() - Date.parse(u.createdAt) });
    }
  }
  private async flush(id: string) {
    const run=this.run(id);
    if (run.variant.deliveryMode !== 'per_utterance') return;
    const receipts = this.store.list('receipts', id), history = this.store.list('utterances', id);
    const pending = receipts.filter(r => r.status !== 'delivered');
    if (!pending.length) {
      // Repair legacy timestamps after a crash following the last receipt write.
      for (const message of history) if (!message.deliveryCompletedAt) this.completeDelivery(id, message, receipts);
      return;
    }
    const barriers = receiveBarriers(history, pending, this.store.list('invocations', id));
    for (const barrier of barriers) {
      const results = await Promise.allSettled(barrier.recipients.map(async batches => {
        for (const batch of batches) {
          const { receipts, messages, characterId, operationKey } = batch;
          const session = run.sessions[characterId], bundled = messages.length > 1;
          this.store.transaction(() => { for (const receipt of receipts) this.store.patch('receipts', receipt.id, { status: 'processing' }); });
          const observations=!!run.sceneObservationVersion;
          const input = bundled ? receiverBatchPrompt(messages, characterId,observations) : receiverPrompt(messages[0], characterId,observations);
          const call = await this.invoke(id, 'receive', session, operationKey, input, {
            sourceUtteranceId: messages[0].id, sourceUtteranceIds: messages.map(u => u.id), receiptIds: receipts.map(r => r.id),
            receivePromptVersion: bundled ? 'npc-receive/2' : 'npc-receive/1', receiveDeliveryVersion: RECEIVE_DELIVERY_VERSION,
          });
          const deliveredAt = now();
          // A crash cannot leave half of one accepted bundle pending.
          this.store.transaction(() => {
            for (const receipt of receipts) this.store.patch('receipts', receipt.id, { status: 'delivered', invocationId: call.id, deliveredAt });
            for (const message of messages) this.completeDelivery(id, message);
          });
        }
      }));
      const failed = results.find(x => x.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    }
  }
  private append(id: string, u: Utterance, accepted?: InvocationMetrics) {
    const run = this.run(id);
    const version = run.variant.characterPerformanceVersion;
    if (u.kind === 'speech' && u.invocationId && ((version && version !== 'off') || run.conversationMemoryVersion || run.sceneFlowVersion)) {
      const session = run.sessions[u.speakerId];
      const call = accepted ?? this.store.get('invocations', u.invocationId)!;
      let next = session;
      if (run.sceneFlowVersion && Array.isArray(call.metadata.sceneSources)) {
        const time=Number(call.metadata.sceneSeconds);
        u.sceneSeconds=time;
        const decision=sceneDecision(parseSpeechOutput(call),call.metadata.sceneSources);
        const deadline=run.sceneFlowVersion==='scene-flow/3' && run.worldState && !decision.wait && !u.action && !u.speech
          ? nextIdleDeadline(run.spec,run.worldState) : Infinity;
        next=applySceneDecision(next,decision,u,time,isAiEnvironment(run.spec,run.variant),deadline);
      }
      if (!session.performance && version && version !== 'off') {
        const slot = run.spec.scenario.characters.findIndex(c => c.id === u.speakerId);
        const performance = committedPerformance(version, run.spec.scenario.characters[slot], slot, call);
        next = {...next,performance};
      }
      if (run.conversationMemoryVersion && call.metadata.memoryOffers) {
        const previous = session.setAsideSequences ?? [];
        const selected = rememberSource(previous,JSON.parse(call.output).setAsideSequence,call.metadata.memoryOffers);
        if (selected !== previous) next = {...next,setAsideSequences:selected};
      }
      if (run.socialReactionVersion && Array.isArray(call.metadata.socialPeers)) {
        const prior=session.socialMemory ?? [];
        const decision=readSocialChoice(JSON.parse(call.output).socialChoice,call.metadata.socialPeers);
        const socialMemory=rememberSocialChoice(prior,decision,u.sequence,run.socialReactionVersion);
        if (socialMemory!==prior) next={...next,socialMemory};
      }
      // Both runners commit the private memory and the public choice atomically.
      if (next !== session) this.store.patch('runs', id, {sessions:{...run.sessions,[u.speakerId]:next}});
    }
    // Elapsed time is already on the next scene clock. Its transcript marker
    // carries no message to deliver and must not wake every sleeping actor.
    if (u.timeCut || !u.perception && isSilentTurn(u)) {
      this.store.put('utterances', { ...u, deliveryCompletedAt: now(), deliveryMs: 0 });
      return;
    }
    this.store.put('utterances', u);
    for (const c of run.spec.scenario.characters) if (c.id !== u.speakerId && receives(u, c.id)) {
      const receipt: DeliveryReceipt = { id: `${u.id}:${c.id}`, runId: id, utteranceId: u.id, characterId: c.id, status: 'pending', invocationId: null, deliveredAt: null };
      this.store.put('receipts', receipt);
    }
    if (u.perception && !this.store.list('receipts', id).some(r => r.utteranceId === u.id)) this.completeDelivery(id, u);
  }
  private async speaker(id: string, speeches: Utterance[], waits:ReadonlyMap<string,number>) {
    const run = this.run(id); if (run.nextSpeakerId) return run.nextSpeakerId;
    const cast=run.spec.scenario.characters;
    const chars=cast.filter(c=>!waits.has(c.id));
    const urgent = environmentMode(run.spec, run.variant) === 'ai' ? priorityWorldSpeaker(run.worldState) : null;
    const cursor=(run.roundRobinCursor ?? speeches.length)%cast.length;
    let selected = urgent ?? [...cast.slice(cursor),...cast.slice(0,cursor)].find(c=>!waits.has(c.id))?.id ?? cast[cursor].id;
    if (!urgent && run.variant.turnPolicy === 'director' && speeches.length && chars.length>1) {
      const age = (characterId: string) => speeches.length - (speeches.findLastIndex(u => u.speakerId === characterId));
      const candidates = chars.filter(c => c.id !== run.lastSpeakerId).sort((a, b) => age(b.id) - age(a.id));
      const allowed = age(candidates[0].id) >= chars.length * 2 ? [candidates[0]] : candidates;
      if (allowed.length === 1) selected = allowed[0].id;
      else {
        const call = await this.direct(id, 'director', `director:${speeches.length + 1}`, directorPrompt({
          characters: chars, allowedSpeakerIds: allowed.map(c => c.id), history: this.store.list('utterances', id), speeches,
          initialScene: run.spec.scenario.situation,
        }));
        selected = JSON.parse(call.output).speakerId;
        if (!allowed.some(c => c.id === selected)) {
          this.store.patch('invocations', call.id, { status: 'failed', error: '허용되지 않은 화자 ID' });
          throw new Error('진행자가 허용되지 않은 화자를 선택했습니다.');
        }
      }
    }
    this.store.patch('runs', id, { nextSpeakerId: selected }); return selected;
  }
  private async advanceWorld(id: string) {
    const run = this.run(id);
    if (environmentMode(run.spec, run.variant) !== 'ai') return;
    const history = this.store.list('utterances', id);
    const state = run.worldState ?? initialWorldState();
    const deadline = state.sceneDeadline;
    const deadlineKey = deadline && 'scene:deadline:'+deadline.at+':'+createHash('sha256').update(JSON.stringify(deadline.processIds)).digest('hex').slice(0,16);
    const source: Utterance | undefined = deadlineKey ? {
      id:deadlineKey,runId:id,sequence:state.processedSequence,speechIndex:state.processedSpeechCount,
      speakerId:'__clock__',speakerName:'장면 시간',kind:'event',speech:'',action:'',
      createdAt:now(),invocationId:null,deliveryCompletedAt:null,deliveryMs:null,
    } : history.find(u => u.kind === 'speech' && u.speechIndex! > state.processedSpeechCount);
    if (!source) return;
    const session = await this.helper(id, 'world-engine', run.spec.worldEngine!, worldPolicies[run.variant.worldPromptVersion ?? LEGACY_WORLD_PROMPT].instructions);
    const contract = worldResponseContract(worldPromptVersion(session.instructions), source);
    const key = deadlineKey ?? `environment:${source.id}`;
    const last = this.store.attempts(id,key).at(-1);
    const ungroundedRecipient = last?.status === 'failed' && last.error?.includes('NPC 물리 상태는 해당 공개 결과');
    const facts = ungroundedRecipient ? z.array(z.union([
      worldFactSchema.extend({scope:z.literal('environment'),npcId:z.null()}),
      worldFactSchema.extend({scope:z.literal('npc_physical'),npcId:z.literal(source.speakerId)}),
    ])).max(100) : undefined;
    const outputSchema = run.npcContextVersion && run.npcContextVersion !== 'npc-context/1'
      ? z.toJSONSchema(contract.validator.extend({events:groundedEvents(false,[source],run.spec.scenario.characters.map(c => c.id)),...(facts && {facts})}))
      : contract.outputSchema;
    const input = deadline ? JSON.stringify({task:'scene_deadline',...managerWorld(run.spec),current:managerState(state,history),due:deadline,
      instruction:'아무도 새 행동을 선택하지 않았다. 지금 시각이 된 사건을 종료하거나, 미래 시각으로 연장하거나, 관찰 가능한 징후와 반응 기회를 남긴다.'})
      : worldPrompt(run.spec, state, history, source);
    const call = await this.invoke(id, 'environment', session, key, input,
      { sourceUtteranceId: deadline ? null : source.id, ...(facts && {repairContract:'grounded-recipient/1'}) },
      deadline ? z.toJSONSchema(deadlineOutput) : outputSchema, history);
    let result: ReturnType<typeof applyWorldOutput>;
    try {
      const output=(deadline ? deadlineOutput : contract.validator).parse(JSON.parse(call.output));
      result = applyWorldOutput(state, output, source, run.spec.scenario.characters.map(c => c.id));
      if (deadline) {
        if (result.state.processes.some(p=>p.status==='pending' && p.readyAtSeconds<=deadline.at && !p.waitingNpcIds.length))
          throw Error('도래한 사건을 종료하거나 미래 시각·반응 조건으로 연장해야 합니다.');
        if (output.processes.some(p=>p.requestNpcIds.length) && !output.events.length)
          throw Error('반응을 요청하기 전에 관찰 가능한 징후가 필요합니다.');
        if (state.facts.some(f=>f.scope==='npc_physical' && output.forgetFactIds.includes(f.id)))
          throw Error('시간 경과만으로 인물 상태를 지울 수 없습니다.');
        result.state.processedSpeechId=state.processedSpeechId;
        delete result.state.sceneDeadline;
      }
    }
    catch (e) { this.store.patch('invocations', call.id, { status: 'failed', error: err(e) }); throw e; }
    this.store.transaction(() => {
      let sequence = this.store.list('utterances', id).length;
      for (const u of clockObservations(run.spec,result.state,id,sequence)) { this.append(id,u); sequence++; }
      for (const event of result.output.events) this.append(id, {
        id: randomUUID(), runId: id, sequence: ++sequence, speechIndex: null, speakerId: '__environment__', speakerName: '세계 엔진',
        kind: 'event', speech: event.text, action: '', createdAt: now(), invocationId: call.id, deliveryCompletedAt: null, deliveryMs: null,
        worldEvent: { ...event, sourceUtteranceId: deadline ? null : source.id, virtualSeconds: result.state.virtualSeconds },
      });
      // Only consume input through the triggering speech. Events injected after
      // it (e.g. during a failed-call pause) must still reach the next tick.
      this.store.patch('runs', id, { worldState: result.state });
      this.store.event(id, call.id, 'world/committed', { sourceUtteranceId: deadline ? null : source.id, ...(deadline && {deadline}), state: result.state, events: result.output.events });
    });
    this.changed(id);
  }
  private advanceQuietScene(run:Run, all:Utterance[], waits:ReadonlyMap<string,number>) {
    if (!run.sceneFlowVersion || run.nextSpeakerId) return false;
    const state=run.worldState;
    if (waits.size!==run.spec.scenario.characters.length || priorityWorldSpeaker(state)) return false;
    const now=sceneTime(run);
    const pending=state?.processes.filter(p=>p.status==='pending' && !p.waitingNpcIds.length) ?? [];
    const to=Math.max(now,Math.min(...waits.values(),...pending.map(p=>p.readyAtSeconds),state ? nextClockBoundary(run.spec,state) : Infinity,
      nextSituationCheck(this.simulationHost(run.id))));
    const due=pending.filter(p=>p.readyAtSeconds<=to).map(p=>p.id).sort();
    if (to===now && !due.length) return false;
    this.store.transaction(()=>{
      let sequence=all.length;
      if (to-now>=1) this.append(run.id,timeCut(run,now,to,++sequence));
      if (state) {
        const next={...state,virtualSeconds:to,firedClockEvents:[...(state.firedClockEvents ?? [])],
          ...(due.length && {sceneDeadline:{at:to,processIds:due}})};
        for (const e of clockObservations(run.spec,next,run.id,sequence)) this.append(run.id,e);
        this.store.patch('runs',run.id,{worldState:next});
      } else this.store.patch('runs',run.id,{sceneSeconds:to});
      this.store.event(run.id,null,'scene/time_advanced',{from:now,to});
    });
    this.changed(run.id);
    return true;
  }
  private async work(id: string) {
    const began = performance.now();
    this.activeStarts.set(id, began);
    try {
      await this.sessions(id);
      if (environmentMode(this.run(id).spec, this.run(id).variant) === 'ai_spatial') {
        await runSpatial(this.simulationHost(id));
        return;
      }
      const initial = this.run(id);
      if (initial.spec.scenario.clockEvents?.some(e => e.atSeconds === 0) && !initial.worldState) this.store.transaction(() => {
        const state = initialWorldState();
        for (const u of clockObservations(initial.spec,state,id,this.store.list('utterances',id).length)) this.append(id,u);
        this.store.patch('runs',id,{worldState:state});
      });
      while (!this.closing && this.run(id).status === 'running') {
        await this.flush(id);
        await this.advanceWorld(id);
        await advanceSingleRoomSituations(this.simulationHost(id));
        await this.flush(id);
        let run = this.run(id); let all = this.store.list('utterances', id); let speeches = all.filter(u => u.kind === 'speech');
        for (const [index, event] of run.spec.scheduledEvents.entries()) if (event.afterUtterance <= speeches.length && !this.run(id).appliedEvents.includes(index)) {
          this.store.transaction(() => { this.appendEvent(id, event.text, event.audience,event.observation); this.store.patch('runs', id, { appliedEvents: [...this.run(id).appliedEvents, index] }); });
        }
        await this.flush(id);
        const rules = environmentMode(run.spec, run.variant) === 'rules';
        const goalsDone = !!(rules && run.spec.scenario.environment?.stopOnGoals && progression(run.spec, this.store.list('utterances', id))?.allGoalsAchieved);
        all=this.store.list('utterances', id);
        const current=this.run(id), waits=waitingActors(current,all);
        const ending = dialogueEnding(current,all,waits);
        await this.evaluatePending(id, speeches.length >= run.spec.maxUtterances || goalsDone || !!ending);
        run = this.run(id);
        if (run.status !== 'running') break;
        if (speeches.length >= run.spec.maxUtterances || goalsDone || ending) { this.store.patch('runs', id, { status: 'completed', completedAt: now(), completionReason: goalsDone ? 'goals_achieved' : ending ?? 'utterance_limit' }); break; }
        if (run.pauseRequested || run.stepRemaining === 0) { this.store.patch('runs', id, { status: 'paused', pausedAt: now(), pauseRequested: false }); break; }
        if (this.advanceQuietScene(run,all,waits)) continue;
        const speakerId = await this.speaker(id, speeches,waits); const session = this.run(id).sessions[speakerId];
        const receipts = this.pending(id, speakerId); all = this.store.list('utterances', id);
        const messages = all.filter(u => receipts.some(r => r.utteranceId === u.id));
        const call = await this.speak(id, session, `speech:${speeches.length + 1}`, speakerPrompt(messages, run.variant.memoryMode === 'reinject_on_speech' ? session.instructions : undefined, rules ? progressionPrompt(run.spec, all, speakerId) : undefined, run.sceneObservationVersion ? speakerId : undefined,undefined,!!run.sceneObservationVersion), { receiptIds: receipts.map(r => r.id) }, all);
        const output = speechSchema.parse(parseSpeechOutput(call)); const character = run.spec.scenario.characters.find(c => c.id === speakerId)!;
        let resolved: ReturnType<typeof resolveAction>;
        try { resolved = rules ? resolveAction(run.spec, all, speakerId, output.actionId) : null; }
        catch (e) { this.store.patch('invocations', call.id, { status: 'failed', error: err(e) }); throw e; }
        this.store.transaction(() => {
          const u: Utterance = { id: randomUUID(), runId: id, sequence: all.length + 1, speechIndex: speeches.length + 1, speakerId, speakerName: character.name, kind: 'speech', speech: output.speech, action: output.action, actionId: output.actionId ?? null, createdAt: now(), invocationId: call.id, deliveryCompletedAt: null, deliveryMs: null };
          this.append(id, u, call);
          if (resolved) {
            const resolution = { actionId: resolved.action.id, sourceUtteranceId: u.id, speechIndex: u.speechIndex!, actorId: speakerId, before: resolved.before, after: resolved.after };
            this.append(id, { id: randomUUID(), runId: id, sequence: u.sequence + 1, speechIndex: null, speakerId: '__environment__', speakerName: '환경 결과', kind: 'event', speech: resolved.action.result, action: '', resolution, createdAt: now(), invocationId: null, deliveryCompletedAt: null, deliveryMs: null });
            this.store.event(id, call.id, 'environment/resolved', resolution);
          }
          for (const attempt of this.store.attempts(id, call.operationKey)) this.store.patch('invocations', attempt.id, { utteranceId: u.id });
          for (const r of receipts) this.store.patch('receipts', r.id, { status: 'delivered', invocationId: call.id, deliveredAt: now() });
          for (const old of messages) this.completeDelivery(id, old);
          const current = this.run(id);
          const cursor = current.roundRobinCursor ?? speeches.length;
          const regularSpeaker = run.spec.scenario.characters[cursor % run.spec.scenario.characters.length].id;
          const basicTime=run.sceneFlowVersion && !isAiEnvironment(run.spec,run.variant);
          const castSize=run.spec.scenario.characters.length;
          const offset=(run.spec.scenario.characters.indexOf(character)-cursor%castSize+castSize)%castSize;
          const turnSeconds=Math.max(1,Math.ceil(output.speech.replace(/\s/gu,'').length/5.5),output.action.trim() ? 3 : 0);
          this.store.patch('runs', id, { lastSpeakerId: speakerId, nextSpeakerId: null,
            ...(basicTime && {sceneSeconds:sceneTime(run)+turnSeconds}),
            roundRobinCursor: run.sceneFlowVersion && run.variant.turnPolicy==='round_robin' && !priorityWorldSpeaker(run.worldState)
              ? cursor+offset+1
              : cursor + (speakerId === regularSpeaker ? 1 : 0),
            stepRemaining: current.stepRemaining === null ? null : Math.max(0, current.stepRemaining - 1) });
        });
        this.changed(id);
      }
      if (this.closing && this.run(id).status === 'running') this.store.patch('runs', id, { status: 'paused', pausedAt: now() });
    } finally {
      this.store.patch('runs', id, { activeMs: this.run(id).activeMs + performance.now() - began, ...(this.run(id).status === 'stopped' ? { completedAt: now() } : {}) });
      this.activeStarts.delete(id);
    }
  }
  private async evaluateRange(id: string, from: number, to: number, attempted = new Set<string>()) {
    const run = this.run(id); const evalId = `${id}:eval:${from}:${to}`;
    if (attempted.has(evalId)) return;
    attempted.add(evalId);
    const previous = this.store.get('evaluations', evalId);
    if (previous?.status === 'completed') return;
    const history = this.store.list('utterances', id);
    // Include the target's authoritative outcome, but never a later speech/result.
    const nextSequence = history.find(u => u.speechIndex !== null && u.speechIndex > to)?.sequence ?? Infinity;
    const spatial = environmentMode(run.spec, run.variant) === 'ai_spatial';
    const earlierIds = new Set(history.filter(u => u.speechIndex !== null && u.speechIndex <= to).map(u => u.id));
    const bounded = history.filter(u => u.sequence < nextSequence || spatial && u.kind === 'event' && !!u.worldEvent?.sourceUtteranceId && earlierIds.has(u.worldEvent.sourceUtteranceId));
    const targets = bounded.filter(u => u.speechIndex !== null && u.speechIndex >= from && u.speechIndex <= to);
    const prompt = evaluationPrompt(run.spec, bounded, targets, run.variant); let call: InvocationMetrics | undefined;
    const previousCall = this.store.list('invocations', id).findLast(c => c.operationKey === `eval:${from}:${to}`);
    // Splitting changes operation keys, so preserve invoke's no-resend guard
    // before a parent range can be replaced by new child model requests.
    if (previousCall && ['uncertain', 'running'].includes(previousCall.status)) {
      this.store.put('evaluations', { id: evalId, runId: id, from, to, status: 'failed', contextTruncated: prompt.truncated,
        summary: '', invocationId: previousCall.id, error: `미확정 호출 ${previousCall.id}: 평가 구간을 분할하거나 자동 재전송하지 않습니다. 재개하여 상태를 확인하세요.` });
      return;
    }
    if (prompt.overBudget && targets.length > 1) {
      const middle = targets[Math.floor(targets.length / 2) - 1].speechIndex!;
      await this.evaluateRange(id, from, middle, attempted);
      await this.evaluateRange(id, middle + 1, to, attempted);
      // Replace an old failed range only after both child ranges are persisted.
      // Its original failure and invocation remain available in the event log.
      if (previous) this.store.transaction(() => {
        this.store.event(id, previous.invocationId, 'evaluation/range_split', { previous, ranges: [[from, middle], [middle + 1, to]] });
        this.store.remove('evaluations', evalId);
      });
      return;
    }
    try {
      if (!targets.length) throw new Error('평가할 대상 발화가 없습니다.');
      if (prompt.overBudget) throw new Error(`평가 대상 발화와 환경 결과가 맥락 문자 한도를 초과합니다 (${prompt.contextCharacters}/${run.spec.evaluation.contextCharacters}). 대상은 생략하지 않았으며 이 구간은 미평가입니다.`);
      const session = await this.helper(id, `judge-${from}-${to}`, run.spec.evaluation, '당신은 NPC 대화의 독립 평가자입니다. 제공한 설정과 공개 기록에서 확인 가능한 근거만 사용하세요. 대화를 교정하거나 참여하지 마세요.');
      call = await this.invoke(id, 'evaluation', session, `eval:${from}:${to}`, prompt.input, { from, to, contextTruncated: prompt.truncated });
      const result = evaluationSchema.parse(JSON.parse(call.output));
      for (const f of result.findings) {
        const u = targets.find(u => u.id === f.utteranceId);
        if (!u || !f.quote || !(u.speech.includes(f.quote) || u.action.includes(f.quote))) throw new Error('평가 근거가 대상 발화와 일치하지 않습니다.');
      }
      this.store.transaction(() => {
        this.store.put('evaluations', { id: evalId, runId: id, from, to, status: 'completed', contextTruncated: prompt.truncated, summary: result.summary, invocationId: call!.id, error: null, quality: { repetition: repetitionMetrics(run.spec, bounded), progression: environmentMode(run.spec, run.variant) === 'rules' ? progression(run.spec, bounded) : null } });
        for (const f of result.findings) this.store.put('findings', { ...f, id: randomUUID(), runId: id, evaluationId: evalId, review: 'unreviewed', note: '' });
      });
    } catch (e) {
      if (call) this.store.patch('invocations', call.id, { status: 'failed', error: err(e) });
      this.store.put('evaluations', { id: evalId, runId: id, from, to, status: 'failed', contextTruncated: prompt.truncated, summary: '', invocationId: call?.id ?? null, error: err(e) });
    }
  }
  private async evaluatePending(id: string, final: boolean, attempted = new Set<string>()) {
    const run = this.run(id); if (!run.spec.evaluation.enabled) return;
    const speeches = this.store.list('utterances', id).filter(u => u.kind === 'speech');
    let count = speeches.length;
    if (!final && environmentMode(run.spec, run.variant) === 'ai_spatial') {
      const pending = new Set(run.worldState?.spatial?.activities.filter(a => a.status === 'pending').map(a => a.sourceUtteranceId));
      const first = speeches.find(u => pending.has(u.id)); if (first) count = first.speechIndex! - 1;
    }
    while (this.run(id).evaluatedThrough < count) {
      const from = this.run(id).evaluatedThrough + 1; const to = Math.min(count, from + run.spec.evaluation.interval - 1);
      if (!final && to - from + 1 < run.spec.evaluation.interval) break;
      await this.evaluateRange(id, from, to, attempted); this.store.patch('runs', id, { evaluatedThrough: to });
    }
  }
  async evaluate(id: string) {
    const run = this.run(id); if (this.workers.has(id)) throw new Error('일시정지한 후 수동 평가를 실행하세요.');
    if (!run.spec.evaluation.enabled) throw new Error('이 실험의 자동 평가 설정이 꺼져 있습니다.');
    await this.startWorker(id, async () => {
      const attempted = new Set<string>();
      for (const e of this.store.list('evaluations', id).filter(x => x.status === 'failed')) await this.evaluateRange(id, e.from, e.to, attempted);
      await this.evaluatePending(id, true, attempted);
    });
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
        if (status === 'completed') try {
          const original=call.kind==='speech' && call.retryOf ? this.store.attempts(id,call.operationKey)[0]?.input : undefined;
          this.validateResponse(run,{...call,output:result.output},original ?? call.input);
        } catch (e) { status = 'failed'; error = err(e); }
        this.store.patch('invocations', call.id, { status, turnId: result.turnId, output: result.output, error, completedAt: now(), metadata: { ...call.metadata, reconciled: true }, durationMs: null });
        if (result.inputRetained !== undefined || result.usage || result.actualModel) {
          this.store.patch('invocations', call.id, { ...(result.usage ? { usage: result.usage, usageStatus: 'reported_response' } : {}),
            ...(result.actualModel ? { actualModel: result.actualModel } : {}), metadata: { ...call.metadata, reconciled: true, ...(result.inputRetained !== undefined ? { inputRetained: result.inputRetained } : {}) } });
          this.store.event(id, call.id, 'response/reconciled', { usage: result.rawUsage ?? null, actualModel: result.actualModel ?? null });
        }
      }
      if (this.run(id).status === 'stopped') throw new Error('상태 확인 중 묶음이 중단되었습니다.');
      this.store.patch('runs', id, { status: 'queued', pauseRequested: false, stepRemaining: step ? 1 : null, error: null }); this.pump();
    } finally {
      this.resuming.delete(id);
      if (this.run(id).status === 'stopped') await this.sessionCleanup.run(id);
    }
  }
  async stop(id: string) {
    const run = this.run(id);
    if (['completed', 'stopped'].includes(run.status)) { await this.cleanupSessions(id); return; }
    this.store.patch('runs', id, { status: 'stopped', completedAt: this.workers.has(id) ? null : now(), pausedAt: null, pausedMs: run.pausedMs + (run.pausedAt ? Date.now() - Date.parse(run.pausedAt) : 0) });
    for (const controller of this.aborts.get(id) ?? []) controller.abort();
    if (!this.workers.has(id) && !this.resuming.has(id)) await this.sessionCleanup.run(id);
    this.changed(id);
  }
  private appendEvent(id: string, text: string, audience?: Audience, observation?: string) {
    const all = this.store.list('utterances', id);
    const run = this.run(id), scoped = audience ?? { scope: 'all' as const, locationIds: [], npcIds: [] };
    if (scoped.scope === 'locations' && environmentMode(run.spec, run.variant) !== 'ai_spatial') throw new Error('장소별 상황 투입은 AI 분산 공간에서 사용하세요.');
    const perception = environmentMode(run.spec, run.variant) === 'ai_spatial' || audience ? {
      locationId: scoped.scope === 'locations' && scoped.locationIds.length === 1 ? scoped.locationIds[0] : null, virtualSeconds: run.worldState?.virtualSeconds ?? 0,
      speechRecipientIds: audienceNpcIds(run.spec, run.worldState, scoped), actionRecipientIds: [], audience: scoped,
    } : undefined;
    const speech=run.sceneObservationVersion ? authoredObservation(text,observation) : observation ?? text;
    this.append(id, { id: randomUUID(), runId: id, sequence: all.length + 1, speechIndex: null, kind: 'event', speakerId: '__narrator__', speakerName: '상황', speech, action: '', createdAt: now(), invocationId: null, deliveryCompletedAt: null, deliveryMs: null, ...(perception ? { perception } : {}) });
    this.store.event(id, null, 'narrator/event', { text, ...(observation!==undefined && {observation}), ...(audience ? { audience } : {}) });
  }
  async inject(id: string, text: string, audience?: Audience, observation?: string) {
    const run = this.run(id); if (run.status !== 'paused' || this.workers.has(id)) throw new Error('상황은 일시정지가 완료된 묶음에 투입하세요.');
    if (run.worldState?.spatial?.cycle || run.worldState?.spatial?.pendingResolution || run.eventGeneratorState?.proposals.some(p => p.status === 'proposed')) throw new Error('미완료 선택·엔진 결과를 먼저 재개하여 확정한 뒤 일시정지하고 상황을 투입하세요. 복구 중인 입력에는 새 사건을 끼워 넣을 수 없습니다.');
    if (!text.trim() || text.length > 100_000) throw new Error('상황 내용은 1~100,000자여야 합니다.');
    if (observation!==undefined && (!observation.trim() || observation.length>100_000)) throw new Error('현장 관찰은 1~100,000자여야 합니다.');
    this.store.transaction(() => this.appendEvent(id, text, audience,observation));
    await this.startWorker(id, async () => { await this.sessions(id); await this.flush(id); });
  }
  review(findingId: string, patch: { review?: 'unreviewed' | 'confirmed' | 'dismissed'; note?: string }) {
    const changes = { ...(patch.review !== undefined ? { review: patch.review } : {}), ...(patch.note !== undefined ? { note: patch.note } : {}) };
    const f = this.store.patch('findings', findingId, changes); this.changed(f.runId); return f;
  }
  private records(run: Run): RunRecords {
    const id = run.id;
    return { run, utterances: this.store.list('utterances', id), invocations: this.store.list('invocations', id),
      findings: this.store.list('findings', id), evaluations: this.store.list('evaluations', id), receipts: this.store.list('receipts', id) };
  }
  private summarize(run: Run, records?: RunRecords): RunSummary {
    const revision = this.store.revision(run.id);
    let cached = this.summaries.get(run.id);
    if (!cached || cached.revision !== revision) {
      cached = { revision, summary: buildRunSummary(records ?? this.records(run)) };
      this.summaries.set(run.id, cached);
    }
    const activeIncrement = this.activeStarts.has(run.id) ? performance.now() - this.activeStarts.get(run.id)! : 0;
    // Return isolated DTOs: a consumer cannot mutate another list/detail view
    // or poison the stored aggregation. Raw prompts and records are not cached.
    return withRunTiming(structuredClone(cached.summary), run, activeIncrement);
  }
  summary(id: string): RunSummary { return this.summarize(this.run(id)); }
  list(provider?: string): RunListItem[] {
    return this.store.list('runs').reverse().filter(run => matchesProvider(run, provider))
      .map(run => toRunListItem(run, this.summarize(run)));
  }
  detail(id: string): RunDetail {
    const records = this.records(this.run(id));
    return { ...records, summary: this.summarize(records.run, records) };
  }
  assertDeletable(id: string) {
    const run = this.run(id);
    if (['running', 'queued'].includes(run.status) || this.workers.has(id) || this.resuming.has(id)) {
      throw new Error('실행 또는 요청 처리가 진행 중입니다. 일시정지·중단이 완료된 뒤 삭제하세요.');
    }
  }
  deleteRun(id: string, notify = true) {
    this.assertDeletable(id);
    this.store.deleteRun(id);
    this.summaries.delete(id);
    if (notify) this.emit('change', { type: 'deleted', runId: id, at: now() });
  }

  async idle() { while (this.workers.size || this.store.list('runs').some(r => r.status === 'queued')) { await Promise.allSettled([...this.workers.values()]); await new Promise(r => setTimeout(r, 5)); } }
  private simulationHost(id: string): SimulationHost {
    return { id, store: this.store, run: () => this.run(id), closing: () => this.closing,
      helper: (key, config, instructions) => this.helper(id, key, config, instructions),
      direct: (key, operationKey, prompt) => this.direct(id, key, operationKey, prompt),
      invoke: (kind, session, key, input, metadata, history) => this.invoke(id, kind, session, key, input, metadata, undefined, history),
      speak: (session, key, input, metadata, history) => this.speak(id, session, key, input, metadata, history),
      append: (u,call) => this.append(id,u,call), flush: () => this.flush(id), changed: () => this.changed(id),
      completeDelivery: u => this.completeDelivery(id, u), inject: (text, audience, observation) => this.appendEvent(id, text, audience,observation),
      evaluate: final => this.evaluatePending(id, final) };
  }
  async cleanupSessions(id?: string) {
    if (this.adapter.name !== 'codex' || !this.adapter.deleteSession) return;
    for (const run of id ? [this.run(id)] : this.store.list('runs')) {
      if (!this.workers.has(run.id) && !this.resuming.has(run.id)) await this.sessionCleanup.run(run.id);
    }
  }
  async close() { this.closing = true; for (const set of this.aborts.values()) for (const c of set) c.abort(); await Promise.allSettled([...this.workers.values()]); await this.cleanupSessions(); await this.adapter.close(); }
}
