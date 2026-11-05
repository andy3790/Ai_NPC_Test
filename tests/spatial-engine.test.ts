import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/core/store.js';
import { Engine } from '../src/core/engine.js';
import { MockAdapter } from '../src/adapters/mock.js';
import { spatialExample } from '../src/shared/spatial-example.js';
import { experimentSchema } from '../src/shared/schema.js';
import { applyConfigSection, readConfigSection } from '../src/shared/config-sections.js';
import { initialSpatialWorld, applySpatialPlan, applySpatialResolution, validateSpatialChoice, commitSpatialChoice, nextSpatialTime, selectableGroups } from '../src/core/spatial-state.js';
import { localContext, visibleUtterance } from '../src/core/perception.js';
import { exportFiles } from '../src/core/export.js';
import { sourceUtteranceIds } from '../src/core/invocation-links.js';
import type { SpatialResolution, SpatialSpeech } from '../src/shared/spatial-schema.js';
import type { Utterance } from '../src/shared/types.js';

function fixture(mode: 'batched_on_turn' | 'per_utterance' = 'batched_on_turn') {
  const s = spatialExample('mock-model'); s.variants = [{ ...s.variants[0], deliveryMode: mode }]; s.maxUtterances = 14; s.evaluation.enabled = false;
  s.scenario.spatial!.initialPositions = s.scenario.characters.map(c => ({ npcId: c.id, locationId: c.id === 'serin' ? 'workshop' : 'lounge' }));
  s.scenario.characters.forEach(c => { c.memories = `PRIVATE_MEMORY_${c.id}`; c.personality = `PRIVATE_PERSONALITY_${c.id}`; c.goals = `PRIVATE_GOAL_${c.id}`; });
  return s;
}
const speech = (change: Partial<SpatialSpeech> = {}): SpatialSpeech => ({ speech: '안녕', action: '', communication: { mode: 'local', targetNpcIds: [], channelId: null }, moveToLocationId: null, activityChoice: 'start', ...change });
const emptyResolution = (): SpatialResolution => ({ completedActivities: [], activityUpdates: [], movements: [], facts: [], forgetFactIds: [], processes: [], finishProcesses: [], events: [], proposalDecision: null });
function utterance(id: string, npcId: string, intent: SpatialSpeech, state = initialSpatialWorld(fixture())): Utterance {
  return { id, runId: 'test', sequence: 1, speechIndex: 1, speakerId: npcId, speakerName: npcId, kind: 'speech', ...intent, spatialIntent: intent,
    createdAt: new Date().toISOString(), invocationId: null, deliveryCompletedAt: null, deliveryMs: null, perception: validateSpatialChoice(fixture(), state, npcId, intent) };
}
function wrap(adapter: MockAdapter, fn: (input: any, output: any, threadId: string) => unknown) {
  const turn = adapter.turn.bind(adapter), originals = new Map<string, any>();
  adapter.turn = async (...args) => {
    const raw = JSON.parse(args[0].input), key = `${args[0].threadId}:${raw.task}`;
    if (raw.previousFailure === undefined) originals.set(key, raw);
    const input = raw.previousFailure !== undefined ? originals.get(key) ?? raw : raw;
    const result = await turn(...args); if (result.status === 'completed') result.output = JSON.stringify(fn(input, JSON.parse(result.output), args[0].threadId));
    return result;
  };
}

test('spatial configuration and section edits validate references, modes and generator requirements', () => {
  const s = fixture(); assert.equal(experimentSchema.parse(s).scenario.spatial!.locations.length, 3);
  const world = readConfigSection(s, 'world'); assert.deepEqual(applyConfigSection(s, 'world', world).scenario.spatial, s.scenario.spatial);
  const conditions = readConfigSection(s, 'conditions'); assert.deepEqual(applyConfigSection(s, 'conditions', conditions).eventGenerator, s.eventGenerator);
  const bad = structuredClone(s); bad.scenario.spatial!.initialPositions.pop(); assert.throws(() => experimentSchema.parse(bad));
  bad.scenario.spatial = s.scenario.spatial; bad.variants[0].eventGeneration = true; delete bad.eventGenerator; assert.throws(() => experimentSchema.parse(bad));
  bad.eventGenerator = s.eventGenerator; bad.variants[0].environmentMode = 'off'; assert.throws(() => experimentSchema.parse(bad));
});

for (const mode of ['batched_on_turn', 'per_utterance'] as const) test(`${mode}: whisper, local, remote and solo actions use frozen observers with no private profile leaks`, async () => {
  const store = new Store(':memory:'), adapter = new MockAdapter(), engine = new Engine(store, adapter, '.cache/history-test-spatial'); adapter.delayMs = 0;
  const counts = new Map<string, number>();
  wrap(adapter, (input, output, thread) => {
    if (input.task !== 'speak') return output;
    const n = (counts.get(thread) ?? 0) + 1; counts.set(thread, n);
    if (adapter.instructions.get(thread)!.includes('당신은 윤입니다') && n === 1) return speech({ speech: 'WHISPER_SECRET', action: '귀 가까이 몸을 기울인다.', communication: { mode: 'whisper', targetNpcIds: ['miru'], channelId: null } });
    if (adapter.instructions.get(thread)!.includes('당신은 세린입니다') && n === 1) return speech({ speech: 'REMOTE_SECRET', communication: { mode: 'channel', targetNpcIds: ['miru'], channelId: 'radio' } });
    return output;
  });
  try {
    const { runs: [run] } = await engine.create(fixture(mode)); await engine.idle(); const d = engine.detail(run.id);
    assert.equal(d.run.status, 'completed', d.run.error ?? ''); assert.equal(d.summary.speechCount, 14);
    const whisper = d.utterances.find(u => u.speech === 'WHISPER_SECRET')!, remote = d.utterances.find(u => u.speech === 'REMOTE_SECRET')!;
    assert.deepEqual(whisper.perception!.speechRecipientIds, ['miru']); assert.deepEqual(whisper.perception!.actionRecipientIds, ['miru', 'doha']);
    assert.deepEqual(d.receipts.filter(r => r.utteranceId === remote.id).map(r => r.characterId), ['miru']);
    assert.equal(d.receipts.some(r => r.utteranceId === whisper.id && r.characterId === 'serin'), false);
    assert.equal(visibleUtterance(whisper, 'doha').speech, ''); assert.equal(visibleUtterance(whisper, 'doha').action, whisper.action);
    for (const id of ['doha', 'serin']) for (const c of d.invocations.filter(c => c.characterId === id)) assert.ok(!c.input.includes('WHISPER_SECRET'));
    for (const c of d.invocations.filter(c => ['yoon', 'doha'].includes(c.characterId ?? ''))) assert.ok(!c.input.includes('REMOTE_SECRET'));
    assert.ok(d.utterances.some(u => u.kind === 'speech' && u.speakerId === 'serin' && !u.speech && u.action));
    for (const c of d.invocations.filter(c => ['environment', 'director', 'event_generation'].includes(c.kind))) {
      assert.ok(!c.input.includes('PRIVATE_')); assert.ok(!adapter.instructions.get(c.threadId)!.includes('PRIVATE_'));
      assert.ok(c.usage.totalTokens! > 0); assert.ok(c.durationMs! >= 0);
    }
    assert.equal(d.invocations.filter(c => c.kind === 'receive').length, mode === 'per_utterance' ? d.receipts.length : 0);
    if (mode === 'per_utterance') assert.ok(d.receipts.every(r => r.status === 'delivered'));
    const files = exportFiles(d, store.events(run.id)), raw = files['records.jsonl'].trim().split('\n').map(x => JSON.parse(x));
    assert.equal(raw.filter(r => r.type === 'invocation').reduce((n, c) => n + (c.usage.totalTokens ?? 0), 0), d.summary.tokens.totalTokens);
    assert.ok(files['utterances.csv'].includes('knownUtteranceIds')); assert.ok(files['invocation-links.csv'].includes('"true"'));
    assert.equal(Object.values(d.summary.byKind).reduce((n, x) => n + x.calls, 0), d.invocations.length);
    const first = d.utterances.filter(u => u.kind === 'speech').slice(0, 2); assert.deepEqual(first.map(u => u.perception!.virtualSeconds), [0, 0]);
  } finally { await engine.close(); store.close(); }
});

test('long actions overlap across rooms and movement does not teleport or reveal destination history', async () => {
  const store = new Store(':memory:'), adapter = new MockAdapter(), engine = new Engine(store, adapter, '.cache/history-test-spatial'); adapter.delayMs = 0;
  const seen = new Set<string>();
  wrap(adapter, (input, out, thread) => {
    if (input.task === 'speak' && !seen.has(thread)) { seen.add(thread);
      if (adapter.instructions.get(thread)!.includes('당신은 윤입니다')) return speech({ speech: '', action: '작업실로 이동한다.', communication: { mode: 'none', targetNpcIds: [], channelId: null }, moveToLocationId: 'workshop' });
      if (adapter.instructions.get(thread)!.includes('당신은 세린입니다')) return speech({ speech: 'DESTINATION_PAST', action: '' });
    }
    if (input.task === 'spatial_plan') for (const plan of out.plans) { const u = input.choices.find((u: any) => u.id === plan.utteranceId); if (u.spatialIntent.moveToLocationId) plan.actionSeconds = 12; }
    return out;
  });
  try {
    const spec = fixture(); spec.maxUtterances = 28;
    const { runs: [run] } = await engine.create(spec); await engine.idle(); const d = engine.detail(run.id);
    assert.equal(d.run.status, 'completed', d.run.error ?? '');
    const move = d.run.worldState!.spatial!.activities.find(a => a.moveToLocationId === 'workshop')!;
    assert.equal(move.startedAtSeconds, 0); assert.equal(move.finishedAtSeconds, 12);
    const others = d.utterances.filter(u => u.kind === 'speech' && u.speakerId !== 'yoon' && u.perception!.virtualSeconds > 0 && u.perception!.virtualSeconds < 12);
    assert.ok(others.length > 3, 'other rooms continue during movement');
    assert.equal(d.run.worldState!.spatial!.positions.find(p => p.npcId === 'yoon')!.locationId, 'workshop');
    const yoon = d.invocations.filter(c => c.characterId === 'yoon'); assert.ok(yoon.every(c => !c.input.includes('DESTINATION_PAST')));
    const moved = d.utterances.find(u => u.worldEvent?.type === 'actor_result' && u.worldEvent.npcId === 'yoon')!;
    assert.equal(moved.perception!.virtualSeconds, 12); assert.deepEqual(moved.perception!.speechRecipientIds.sort(), ['serin', 'yoon']);
    for (const c of d.invocations.filter(c => c.kind === 'speech' && c.characterId === 'yoon' && Number(c.metadata.virtualSeconds) > 0)) assert.ok(Number(c.metadata.virtualSeconds) >= 12);
  } finally { await engine.close(); store.close(); }
});

test('reaction opportunities preserve an ongoing action until the NPC chooses continue or cancel', () => {
  const spec = fixture(); let state = initialSpatialWorld(spec);
  const repair = utterance('repair', 'miru', speech({ action: '긴 수리를 시작한다.' }), state);
  state = applySpatialPlan(spec, state, [repair], { plans: [{ utteranceId: 'repair', speechSeconds: 1, actionSeconds: 30, reactionNpcIds: [], movementStarts: false }] });
  const event = { type: 'observation', text: '바닥으로 물이 번지고 있다.', npcId: null, evidence: null, processId: 'spill', sourceUtteranceId: null, proposalId: null, audience: { scope: 'locations', locationIds: ['lounge'], npcIds: [] } };
  state.virtualSeconds = 3;
  state = applySpatialResolution(spec, state, [repair], { ...emptyResolution(), processes: [{ id: 'spill', description: '바닥으로 번지는 물', readyAtSeconds: 5, requestNpcIds: ['miru'], locationIds: ['lounge'] }], events: [event] }).state;
  assert.equal(selectableGroups(spec, state, [repair])[0].ids[0], 'miru');
  assert.throws(() => validateSpatialChoice(spec, state, 'miru', speech()), /계속·중단/);
  const response = utterance('continue', 'miru', speech({ speech: '수리부터 마칠게.', activityChoice: 'continue' }), state);
  const continuing = commitSpatialChoice(state, response);
  assert.equal(continuing.spatial!.activities[0].status, 'pending'); assert.deepEqual(continuing.processes[0].offeredNpcIds, ['miru']);
  const cancel = utterance('cancel', 'miru', speech({ speech: '', action: '', communication: { mode: 'none', targetNpcIds: [], channelId: null }, activityChoice: 'cancel' }), state);
  const cancelled = commitSpatialChoice(state, cancel); assert.equal(cancelled.spatial!.activities[0].status, 'cancelled');
  assert.equal(cancelled.spatial!.activities[0].finishedAtSeconds, 3);
  assert.throws(() => applySpatialResolution(spec, state, [repair], { ...emptyResolution(), completedActivities: [{ id: 'repair', outcome: 'completed', reason: '조기 완료' }] }), /아직 완료/);
  assert.throws(() => applySpatialResolution(spec, state, [repair], { ...emptyResolution(), events: [{ ...event, type: 'physical_effect', npcId: 'miru' }] }), /반응 기회/);
  const source = utterance('throw', 'yoon', speech({ action: '미루에게 공을 던진다.' }), state);
  assert.throws(() => applySpatialResolution(spec, state, [repair, source], { ...emptyResolution(), events: [{ ...event, type: 'actor_result', npcId: 'miru', sourceUtteranceId: 'throw', evidence: source.action }] }), /본인이 선택/);
});

test('movement cancellation stays in transit, route validation and current visible facts are scoped', () => {
  const spec = fixture(); let state = initialSpatialWorld(spec);
  const intent = speech({ action: '작업실로 간다.', moveToLocationId: 'workshop' });
  assert.throws(() => validateSpatialChoice(spec, state, 'serin', speech({ action: '관제실로 간다.', moveToLocationId: 'control' })), /연결되지/);
  const u = utterance('move', 'yoon', intent, state);
  state = applySpatialPlan(spec, state, [u], { plans: [{ utteranceId: u.id, speechSeconds: 1, actionSeconds: 10, reactionNpcIds: [], movementStarts: true }] });
  assert.equal(state.spatial!.positions[0].locationId, null); assert.equal(nextSpatialTime(state), 1);
  const cancel = utterance('halt', 'yoon', speech({ action: '통로에서 멈춘다.', activityChoice: 'cancel' }), state);
  state = commitSpatialChoice(state, cancel); assert.equal(state.spatial!.positions[0].locationId, null);
  assert.doesNotThrow(() => validateSpatialChoice(spec, state, 'yoon', speech({ action: '되돌아간다.', moveToLocationId: 'lounge' })));
  assert.deepEqual(localContext(spec, state, 'yoon').routes.map(r => r.toLocationId).sort(), ['lounge', 'workshop']);
  state.facts = [{ id: 'visible', text: '현장의 젖은 바닥', scope: 'environment', npcId: null, locationId: 'lounge', visibility: 'visible' }, { id: 'secret', text: 'HIDDEN_FACT', scope: 'environment', npcId: null, locationId: 'lounge', visibility: 'hidden' }];
  assert.equal(localContext(spec, state, 'miru').visibleFacts.length, 1); assert.equal(localContext(spec, state, 'serin').visibleFacts.length, 0);
});

test('parallel choices and recipient failures resume without repeating completed calls; step commits one choice', async () => {
  const store = new Store(':memory:'), adapter = new MockAdapter(), engine = new Engine(store, adapter, '.cache/history-test-spatial'); adapter.delayMs = 0;
  try {
    const spec = fixture('per_utterance'); spec.maxUtterances = 8;
    const { runs: [run] } = await engine.create(spec, false);
    await engine.resume(run.id, true); await engine.idle(); assert.equal(engine.detail(run.id).summary.speechCount, 1); assert.equal(engine.detail(run.id).run.status, 'paused');
    adapter.failNextKind = 'receive'; await engine.resume(run.id); await engine.idle();
    const paused = engine.detail(run.id); assert.equal(paused.run.status, 'paused'); assert.ok(paused.invocations.some(c => c.status === 'failed'));
    const completed = paused.invocations.filter(c => c.status === 'completed').map(c => c.id);
    await engine.resume(run.id); await engine.idle(); const d = engine.detail(run.id); assert.equal(d.run.status, 'completed', d.run.error ?? '');
    assert.equal(d.summary.speechCount, 8); assert.ok(completed.every(id => d.invocations.filter(c => c.id === id).length === 1));
    assert.ok(d.receipts.every(r => r.status === 'delivered')); assert.equal(new Set(d.receipts.map(r => `${r.characterId}:${r.utteranceId}`)).size, d.receipts.length);
    assert.equal(d.invocations.filter(c => c.kind === 'speech').length, 8);
    for (const c of d.invocations.filter(c => c.kind === 'environment')) assert.ok(sourceUtteranceIds(c).every(id => d.utterances.some(u => u.id === id)));
  } finally { await engine.close(); store.close(); }
});

for (const environmentMode of ['ai', 'ai_spatial'] as const) test(`${environmentMode}: optional situations are reviewed, rate limited, metered and scoped`, async () => {
  const store = new Store(':memory:'), adapter = new MockAdapter(), engine = new Engine(store, adapter, '.cache/history-test-spatial'); adapter.delayMs = 0;
  wrap(adapter, (input, out) => input.task === 'event_generation' ? { proposal: { title: '통신 잡음', description: '업무 무전에서 짧은 잡음이 난다.', locationIds: environmentMode === 'ai_spatial' ? ['lounge'] : [], severity: 'low' } } : out);
  try {
    const spec = fixture('per_utterance'); spec.variants[0].environmentMode = environmentMode; spec.variants[0].eventGeneration = true;
    Object.assign(spec.eventGenerator!, { intervalSeconds: 1, minGapSeconds: 3, maxProposals: 2, maxChecks: 5 });
    const { runs: [run] } = await engine.create(spec); await engine.idle(); const d = engine.detail(run.id);
    assert.equal(d.run.status, 'completed', d.run.error ?? ''); assert.equal(d.run.eventGeneratorState!.proposals.length, 2);
    assert.ok(d.run.eventGeneratorState!.proposals.every(p => p.status === 'accepted'));
    const p = d.run.eventGeneratorState!.proposals; assert.ok(p[1].virtualSeconds - p[0].virtualSeconds >= 3);
    assert.equal(d.summary.byKind.event_generation.calls, 2); assert.ok(d.summary.byKind.event_generation.tokens.totalTokens! > 0);
    const proposals = d.utterances.filter(u => u.worldEvent?.proposalId); assert.equal(proposals.length, 2);
    if (environmentMode === 'ai_spatial') assert.ok(proposals.every(u => !u.perception!.speechRecipientIds.includes('serin')));
    const engineCalls = d.invocations.filter(c => ['event_generation', 'environment'].includes(c.kind)); assert.ok(engineCalls.every(c => !c.input.includes('PRIVATE_')));
    assert.ok(d.invocations.filter(c => c.kind === 'receive').every(c => !c.output.includes('speech')));
  } finally { await engine.close(); store.close(); }
});

test('parallel runs use isolated sessions, director fairness, reinjection and a shared concurrency limit', async () => {
  const store = new Store(':memory:'), adapter = new MockAdapter(), engine = new Engine(store, adapter, '.cache/history-test-spatial'); adapter.delayMs = 2;
  let active = 0, peak = 0; const threads = new Set<string>(), turn = adapter.turn.bind(adapter);
  adapter.turn = async (...args) => { assert.ok(!threads.has(args[0].threadId), 'same NPC cannot receive two concurrent requests'); threads.add(args[0].threadId); peak = Math.max(peak, ++active); try { return await turn(...args); } finally { active--; threads.delete(args[0].threadId); } };
  try {
    const spec = fixture('per_utterance'); spec.repetitions = 2; spec.maxConcurrentCalls = 2; spec.variants[0].turnPolicy = 'director'; spec.variants[0].memoryMode = 'reinject_on_speech';
    const { runs } = await engine.create(spec); await engine.idle(); const details = runs.map(r => engine.detail(r.id));
    assert.equal(peak, 2); assert.ok(details.every(d => d.run.status === 'completed'));
    assert.notEqual(details[0].run.helperSessions['spatial-time-planner'].threadId, details[1].run.helperSessions['spatial-time-planner'].threadId);
    for (const d of details) {
      assert.ok(d.summary.byKind.director.calls > 0); assert.equal(new Set(d.utterances.filter(u => u.kind === 'speech').map(u => u.speakerId)).size, 4);
      for (const call of d.invocations) {
        if (call.kind === 'speech') assert.ok(JSON.parse(call.input).originalCharacterAndWorld);
        if (call.kind === 'receive') assert.equal(JSON.parse(call.input).originalCharacterAndWorld, undefined);
        if (call.kind === 'environment') assert.ok(sourceUtteranceIds(call).every(id => d.utterances.some(u => u.id === id)));
      }
      assert.equal(d.summary.byKind.event_generation.calls, 0);
    }
  } finally { await engine.close(); store.close(); }
});

for (const stage of ['spatial_plan', 'spatial_resolve'] as const) test(`${stage}: uncertain completion after restart is reconciled once and unknown outcomes never resend`, async () => {
  const store = new Store(':memory:'), adapter = new MockAdapter(); let engine = new Engine(store, adapter, '.cache/history-test-spatial'); adapter.delayMs = 0;
  let once = true; const turn = adapter.turn.bind(adapter);
  adapter.turn = async (...args) => { const result = await turn(...args); if (JSON.parse(args[0].input).task === stage && once) { once = false; throw new Error('disconnect after completion'); } return result; };
  try {
    const spec = fixture(); spec.maxUtterances = 6;
    const { runs: [run] } = await engine.create(spec); await engine.idle(); const paused = engine.detail(run.id);
    const call = paused.invocations.find(c => c.status === 'uncertain')!; assert.ok(call); const previousPosts = adapter.requests.length;
    await engine.close(); engine = new Engine(store, adapter, '.cache/history-test-spatial');
    const reconcile = adapter.reconcile.bind(adapter); adapter.reconcile = async () => null;
    await assert.rejects(engine.resume(run.id), /자동 재전송하지/); assert.equal(adapter.requests.length, previousPosts);
    adapter.reconcile = reconcile; await engine.resume(run.id); await engine.idle(); const d = engine.detail(run.id);
    assert.equal(d.run.status, 'completed', d.run.error ?? ''); assert.equal(d.invocations.filter(c => c.operationKey === call.operationKey).length, 1);
    assert.equal(d.invocations.filter(c => c.kind === 'speech').length, 6); assert.equal(d.summary.speechCount, 6);
  } finally { await engine.close(); store.close(); }
});

test('choice transaction rollback preserves successful parallel calls and commits each decision only once', async () => {
  const store = new Store(':memory:'), adapter = new MockAdapter(), engine = new Engine(store, adapter, '.cache/history-test-spatial'); adapter.delayMs = 0;
  const put = store.put.bind(store); let written = 0;
  store.put = ((table: any, value: any) => { if (table === 'utterances' && ++written === 2) throw new Error('transaction failure'); return put(table, value); }) as typeof store.put;
  try {
    const spec = fixture(); spec.maxUtterances = 2;
    const { runs: [run] } = await engine.create(spec); await engine.idle(); assert.equal(engine.detail(run.id).summary.speechCount, 0);
    assert.equal(engine.detail(run.id).invocations.filter(c => c.kind === 'speech').length, 2);
    await assert.rejects(engine.inject(run.id, 'UNCOMMITTED_INJECTION'), /미완료 선택/);
    await engine.resume(run.id); await engine.idle(); const d = engine.detail(run.id);
    assert.equal(d.run.status, 'completed', d.run.error ?? ''); assert.equal(d.summary.speechCount, 2); assert.equal(d.invocations.filter(c => c.kind === 'speech').length, 2);
  } finally { await engine.close(); store.close(); }
});

test('rejected or excessive situation proposals cannot leak into the world', async () => {
  const store = new Store(':memory:'), adapter = new MockAdapter(), engine = new Engine(store, adapter, '.cache/history-test-spatial'); adapter.delayMs = 0;
  let excessive = true;
  wrap(adapter, (input, out) => {
    if (input.task === 'event_generation') return { proposal: { title: '제안', description: 'REJECTED_PROPOSAL', locationIds: ['lounge'], severity: excessive ? 'high' : 'low' } };
    if (input.task === 'spatial_resolve' && input.proposal) return { ...emptyResolution(), proposalDecision: { accepted: false, reason: '세계 설정과 불일치' } };
    return out;
  });
  try {
    const spec = fixture(); spec.variants[0].eventGeneration = true; Object.assign(spec.eventGenerator!, { intervalSeconds: 1, minGapSeconds: 0, maxChecks: 1, maxProposals: 1, maxSeverity: 'low' });
    const { runs: [run] } = await engine.create(spec); await engine.idle(); const paused = engine.detail(run.id);
    assert.equal(paused.run.status, 'paused'); assert.match(paused.run.error!, /허용 강도/); assert.equal(paused.run.eventGeneratorState, undefined);
    excessive = false; await engine.resume(run.id); await engine.idle(); const d = engine.detail(run.id);
    assert.equal(d.run.status, 'completed', d.run.error ?? ''); assert.equal(d.run.eventGeneratorState!.proposals[0].status, 'rejected');
    assert.ok(d.utterances.every(u => !u.speech.includes('REJECTED_PROPOSAL'))); assert.ok(d.invocations.filter(c => c.characterId).every(c => !c.input.includes('REJECTED_PROPOSAL')));
    assert.equal(d.summary.byKind.event_generation.calls, 2); assert.equal(d.summary.byKind.event_generation.failed, 1);
  } finally { await engine.close(); store.close(); }
});

test('local manual and scheduled events respect observation scope even before sessions initialize', async () => {
  const store = new Store(':memory:'), adapter = new MockAdapter(), engine = new Engine(store, adapter, '.cache/history-test-spatial'); adapter.delayMs = 0;
  try {
    const spec = fixture('per_utterance'); spec.maxUtterances = 6;
    spec.scheduledEvents = [{ afterUtterance: 2, text: 'LATER_ROOM', audience: { scope: 'locations', locationIds: ['lounge'], npcIds: [] } }];
    const { runs: [run] } = await engine.create(spec, false);
    await engine.inject(run.id, 'INITIAL_ROOM', { scope: 'locations', locationIds: ['workshop'], npcIds: [] });
    await engine.resume(run.id); await engine.idle(); const d = engine.detail(run.id);
    assert.equal(d.run.status, 'completed', d.run.error ?? '');
    for (const text of ['INITIAL_ROOM', 'LATER_ROOM']) {
      const u = d.utterances.find(u => u.speech === text)!; assert.ok(u);
      assert.equal(d.receipts.filter(r => r.utteranceId === u.id).length, text === 'INITIAL_ROOM' ? 1 : 3);
    }
    for (const c of d.invocations.filter(c => c.characterId === 'serin')) assert.ok(!c.input.includes('LATER_ROOM'));
  } finally { await engine.close(); store.close(); }
});
