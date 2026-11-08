import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/core/store.js';
import { Engine } from '../src/core/engine.js';
import { MockAdapter } from '../src/adapters/mock.js';
import { exampleSpec } from '../src/shared/example.js';
import { environmentMode, experimentSchema } from '../src/shared/schema.js';
import { applyConfigSection, readConfigSection } from '../src/shared/config-sections.js';
import { initialWorldState, applyWorldOutput, worldPrompt, worldResponseContract } from '../src/core/world.js';
import { exportFiles } from '../src/core/export.js';
import { aggregate } from '../src/core/metrics.js';
import { filterRuns, emptyRunFilters } from '../src/shared/run-filters.js';
import type { Utterance } from '../src/shared/types.js';
import type { WorldOutput } from '../src/shared/world-schema.js';

const silent = (seconds = 1): WorldOutput => ({ elapsedSeconds: seconds, facts: [], forgetFactIds: [], processes: [], finishProcesses: [], events: [] });
function specFor(mode: 'batched_on_turn' | 'per_utterance' = 'batched_on_turn') {
  const spec = exampleSpec('mock-model');
  spec.variants = [{ ...spec.variants[0], deliveryMode: mode, environmentMode: 'ai' }];
  spec.worldEngine = { model: 'mock-model', effort: 'medium' };
  spec.maxUtterances = 6; spec.evaluation.enabled = false;
  spec.scenario.world = '휴게실에는 공, 물컵, 탁자, 휴지가 있다. 세 NPC는 모두 여기 있다. 기존 관제실에 메시지를 보낼 수 있다. 마법은 없다.';
  spec.scenario.situation = '윤이 공을 들고 있고 미루는 건너편, 도하는 탁자 곁에 있다.';
  spec.scenario.characters.forEach((c, i) => { c.memories = `PRIVATE_MEMORY_${i}`; c.personality = `PRIVATE_PERSONALITY_${i}`; c.goals = `PRIVATE_GOAL_${i}`; });
  // Keep authored rules present: the AI variant must not leak/apply those rules.
  return spec;
}
function scripted(adapter: MockAdapter) {
  const original = adapter.turn.bind(adapter); let count = 0;
  adapter.turn = async (...args) => {
    const result = await original(...args); const input = JSON.parse(args[0].input);
    if (result.status !== 'completed') return result;
    if (input.task === 'speak') {
      count++;
      result.output = JSON.stringify({ speech: `지금 이 일에 반응한다 ${count}`, action: count === 1 ? '미루에게 공을 던진다.' : count === 2 ? '공을 두 손으로 받으려 한다.' : count === 3 ? '탁자 위 물컵을 건드린다.' : '주변을 살핀다.' });
    } else if (input.task === 'environment') {
      const n = input.state.processedSpeechCount + 1; const out = silent(n <= 4 ? n : 1);
      if (n === 1) {
        out.processes = [{ id: 'ball', description: '미루 쪽으로 날아가는 공', readyAtSeconds: 1, requestNpcIds: ['miru'] }, { id: 'reply', description: '관제실 답장 대기', readyAtSeconds: 9, requestNpcIds: [] }];
        out.events = [{ type: 'observation', text: '공이 미루 쪽으로 날아간다.', npcId: null, evidence: null, processId: 'ball' }];
      } else if (n === 2) {
        out.finishProcesses = [{ id: 'ball', outcome: 'completed', reason: '미루가 스스로 받기를 시도했다.' }];
        out.events = [{ type: 'actor_result', text: '공이 미루의 두 손에 들어왔다.', npcId: 'miru', evidence: '공을 두 손으로 받으려 한다.', processId: 'ball' }];
        out.facts = [{ id: 'ball_holder', scope: 'npc_physical', npcId: 'miru', text: '미루의 두 손에 공이 있다.' }];
      } else if (n === 3) {
        out.processes = [{ id: 'water', description: '물 번짐', readyAtSeconds: 8, requestNpcIds: [] }];
        out.events = [{ type: 'observation', text: '물이 탁자 위에 번지기 시작한다.', npcId: null, evidence: null, processId: 'water' }];
      } else if (n === 4) {
        out.finishProcesses = [{ id: 'water', outcome: 'completed', reason: '탁자 가장자리에 도달했다.' }, { id: 'reply', outcome: 'completed', reason: '답장이 도착했다.' }];
        out.events = [{ type: 'observation', text: '물이 가장자리를 넘어 바닥으로 떨어진다.', npcId: null, evidence: null, processId: 'water' }, { type: 'external_signal', text: '관제실에서 수신했다는 답장이 도착한다.', npcId: null, evidence: null, processId: 'reply' }];
        out.facts = [{ id: 'floor', scope: 'environment', npcId: null, text: '탁자 아래 바닥이 젖었다.' }];
      }
      result.output = JSON.stringify(out);
    }
    return result;
  };
}

for (const mode of ['batched_on_turn', 'per_utterance'] as const) test(`${mode}: world consequences, virtual delays, priority reaction, privacy, usage and export`, async () => {
  const store = new Store(':memory:'), adapter = new MockAdapter(), engine = new Engine(store, adapter, '.cache/world-test');
  adapter.delayMs = 1; scripted(adapter);
  try {
    const spec = specFor(mode); spec.evaluation.enabled = true; spec.evaluation.interval = 3;
    const { runs: [run] } = await engine.create(spec); await engine.idle(); const d = engine.detail(run.id);
    assert.equal(d.run.status, 'completed', d.run.error ?? '');
    assert.equal(engine.list()[0].environmentMode, 'ai');
    assert.equal(filterRuns(engine.list(), { ...emptyRunFilters, environmentModes: ['ai'] }).length, 1);
    assert.equal(filterRuns(engine.list(), { ...emptyRunFilters, environmentModes: ['off'] }).length, 0);
    const speeches = d.utterances.filter(u => u.kind === 'speech'), worlds = d.invocations.filter(c => c.kind === 'environment');
    assert.deepEqual(speeches.map(u => u.speakerId), ['yoon', 'miru', 'doha', 'miru', 'yoon', 'doha']);
    assert.equal(worlds.length, 6); assert.equal(d.summary.speechCount, 6); assert.equal(d.summary.quality.progression, null);
    assert.equal(d.utterances.filter(u => u.worldEvent).length, 5);
    assert.equal(d.run.worldState?.virtualSeconds, 12); assert.equal(d.run.worldState?.processedSpeechCount, 6);
    assert.ok(d.run.worldState?.processes.every(p => p.status === 'completed'));
    assert.deepEqual(d.run.worldState?.processes.find(p => p.id === 'ball')?.offeredNpcIds, ['miru']);
    assert.equal(d.run.worldState?.processes.find(p => p.id === 'reply')?.finishedAtSeconds, 10);
    assert.ok(d.utterances.every(u => !u.resolution));
    for (const call of worlds) {
      assert.equal(call.effort, 'medium'); assert.equal(call.environmentMode, 'ai');
      assert.equal(call.usageStatus, 'reported_cumulative_delta'); assert.ok(call.usage.totalTokens! > 0); assert.ok(call.durationMs! >= 0);
      assert.ok(!call.input.includes('PRIVATE_')); assert.ok(!call.input.includes('ignite_lamp'));
      const input = JSON.parse(call.input); assert.deepEqual(Object.keys(input.npcs[0]), ['id', 'name']);
      assert.ok(!adapter.instructions.get(call.threadId)?.includes('PRIVATE_'));
    }
    for (const u of speeches.slice(1)) {
      const previous = speeches[u.speechIndex! - 2];
      const world = worlds.find(c => c.sourceUtteranceId === previous.id)!;
      assert.ok(world.completedAt! <= d.invocations.find(c => c.id === u.invocationId)!.startedAt!);
    }
    const npcCalls = d.invocations.filter(c => ['speech', 'receive'].includes(c.kind));
    assert.ok(npcCalls.every(c => !c.input.includes('readyAtSeconds') && !c.input.includes('waitingNpcIds')));
    const judged = JSON.parse(d.invocations.filter(c => c.kind === 'evaluation')[0].input);
    assert.ok(judged.worldEnginePolicy.includes('자연스러운 세부사항')); assert.equal(judged.progress, null);
    if (mode === 'per_utterance') {
      assert.equal(d.summary.byKind.receive.calls, 6 * 2 + 5 * 3); assert.equal(d.summary.pendingReceipts, 0);
      for (const u of d.utterances) {
        const next = speeches.find(s => s.sequence > u.sequence);
        if (next) assert.ok(d.invocations.filter(c => c.kind === 'receive' && c.sourceUtteranceId === u.id).every(c => c.completedAt! <= d.invocations.find(c => c.id === next.invocationId)!.startedAt!));
      }
    } else {
      assert.equal(d.summary.byKind.receive.calls, 0); assert.ok(d.summary.pendingReceipts > 0);
      for (const npc of spec.scenario.characters) {
        const messages = npcCalls.filter(c => c.characterId === npc.id).flatMap(c => JSON.parse(c.input).messages ?? []);
        assert.equal(new Set(messages.map(m => m.id)).size, messages.length);
        assert.ok(messages.every(m => m.speakerId !== npc.id));
      }
    }
    const total = Object.values(d.summary.byKind).reduce((n, x) => n + (x.tokens.totalTokens ?? 0), 0);
    assert.equal(total, d.summary.tokens.totalTokens);
    assert.equal(d.summary.byKind.environment.tokens.totalTokens, aggregate(worlds).tokens.totalTokens);
    const files = exportFiles(d, store.events(run.id));
    assert.deepEqual(JSON.parse(files['world-state.json']), d.run.worldState);
    assert.equal(files['world-timeline.csv'].split('\r\n').length, 8);
    assert.ok(files['utterances.csv'].includes('environmentTokens')); assert.ok(files['invocations.csv'].includes('"environment"'));
    const rows = files['records.jsonl'].trim().split('\n').map(s => JSON.parse(s));
    assert.equal(rows.filter(r => r.type === 'invocation').reduce((n, c) => n + (c.usage.totalTokens ?? 0), 0), total);
  } finally { await engine.close(); store.close(); }
});

const source: Utterance = { id: 'speech-1', runId: 'r', sequence: 1, speechIndex: 1, speakerId: 'a', speakerName: 'A', kind: 'speech', speech: '받아!', action: 'B에게 공을 던진다.', createdAt: '', invocationId: null, deliveryCompletedAt: null, deliveryMs: null };

test('quiet-time contract is versioned; v6 cannot freeze or jump time while old sessions retain their schema', () => {
  const quiet = { ...source, speech: '', action: '' };
  for (const version of [null, 'npc-world/4', 'npc-world/5']) assert.doesNotThrow(() => worldResponseContract(version, quiet).validator.parse(silent(0)));
  for (const seconds of [0, 2, 120]) assert.throws(() => worldResponseContract('npc-world/6', quiet).validator.parse(silent(seconds)));
  assert.doesNotThrow(() => worldResponseContract('npc-world/6', quiet).validator.parse(silent(1)));
  assert.doesNotThrow(() => worldResponseContract('npc-world/6', source).validator.parse(silent(4)));
});

test('quiet NPC choices advance a delayed result at its due time without inventing NPC speech or actions', async () => {
  const store = new Store(':memory:'), adapter = new MockAdapter(), engine = new Engine(store, adapter, '.cache/world-quiet');
  adapter.delayMs = 0; const turn = adapter.turn.bind(adapter);
  adapter.turn = async (...args) => {
    const request = args[0], p = JSON.parse(request.input), result = await turn(...args);
    if (p.task === 'speak') result.output = JSON.stringify({ speech: '', action: '' });
    if (p.task === 'environment') {
      assert.equal((request.outputSchema as any).properties.elapsedSeconds.const, 1);
      const out = silent(1);
      if (p.state.processes.some((p: any) => p.id === 'reply') && p.state.virtualSeconds + 1 >= 2) {
        out.finishProcesses = [{ id: 'reply', outcome: 'completed', reason: '응답 도착' }];
        out.events = [{ type: 'external_signal', text: '화면에 확인 응답이 뜬다.', npcId: null, evidence: null, processId: 'reply' }];
      }
      result.output = JSON.stringify(out);
    }
    return result;
  };
  try {
    const spec = specFor(); spec.maxUtterances = 3; spec.variants[0].worldPromptVersion = 'npc-world/6';
    const { runs: [run] } = await engine.create(spec, false);
    store.patch('runs', run.id, { worldState: { ...initialWorldState(), processes: [{ id: 'reply', description: '확인 응답', readyAtSeconds: 2, createdAtSeconds: 0,
      sourceUtteranceId: 'initial', waitingNpcIds: [], offeredNpcIds: [], status: 'pending', finishedAtSeconds: null, reason: null }] } });
    await engine.resume(run.id); await engine.idle(); const d = engine.detail(run.id);
    assert.equal(d.run.status, 'completed', d.run.error ?? ''); assert.equal(d.run.worldState!.virtualSeconds, 3);
    assert.equal(d.run.worldState!.processes[0].finishedAtSeconds, 2);
    assert.ok(d.utterances.filter(u => u.kind === 'speech').every(u => !u.speech && !u.action));
    const calls = d.invocations.filter(c => c.kind === 'environment');
    assert.equal(JSON.parse(calls[0].output).events.length, 0); assert.equal(JSON.parse(calls[1].output).events.length, 1);
    const lastSpeaker = d.invocations.filter(c => c.kind === 'speech').at(-1)!;
    assert.ok(JSON.parse(lastSpeaker.input).messages.some((u: any) => u.observation === '화면에 확인 응답이 뜬다.'));
  } finally { await engine.close(); store.close(); }
});
test('a provider ignoring the quiet-time schema pauses before commit and resumes without replaying the NPC choice', async () => {
  const store = new Store(':memory:'), adapter = new MockAdapter(), engine = new Engine(store, adapter, '.cache/world-quiet-invalid');
  adapter.delayMs = 0; const turn = adapter.turn.bind(adapter); let invalid = true;
  adapter.turn = async (...args) => {
    const result = await turn(...args), input = JSON.parse(args[0].input);
    if (input.task === 'speak') result.output = JSON.stringify({ speech: '', action: '' });
    if (input.task === 'environment') { result.output = JSON.stringify(silent(invalid ? 0 : 1)); invalid = false; }
    return result;
  };
  try {
    const spec = specFor(); spec.maxUtterances = 1; spec.variants[0].worldPromptVersion = 'npc-world/6';
    const { runs: [run] } = await engine.create(spec); await engine.idle(); let d = engine.detail(run.id);
    assert.equal(d.run.status, 'paused'); assert.match(d.run.error!, /elapsedSeconds/);
    assert.equal(d.run.worldState, undefined); assert.equal(d.utterances.length, 1);
    const failed = d.invocations.at(-1)!; assert.equal(failed.status, 'failed');
    assert.equal(JSON.parse(failed.output).elapsedSeconds, 0);
    await engine.resume(run.id); await engine.idle(); d = engine.detail(run.id);
    assert.equal(d.run.status, 'completed', d.run.error ?? ''); assert.equal(d.run.worldState?.virtualSeconds, 1);
    assert.equal(d.summary.byKind.speech.calls, 1); assert.equal(d.summary.byKind.environment.calls, 2);
    assert.equal(d.invocations.at(-1)!.retryOf, failed.id);
    assert.match(JSON.parse(d.invocations.at(-1)!.input).previousFailure, /elapsedSeconds/);
    assert.equal(d.utterances.length, 1);
  } finally { await engine.close(); store.close(); }
});

test('world validator rejects choices for other NPCs, premature physical effects, unknown IDs and early completion', () => {
  const state = initialWorldState();
  const out = silent(); out.processes.push({ id: 'ball', description: '공이 날아감', readyAtSeconds: 2, requestNpcIds: ['b'] });
  const pending = applyWorldOutput(state, out, source, ['a', 'b']).state;
  const finish = silent(0); finish.finishProcesses.push({ id: 'ball', outcome: 'completed', reason: '잡았다' });
  assert.throws(() => applyWorldOutput(pending, finish, { ...source, id: 's2', speechIndex: 2 }, ['a', 'b']), /반응 기회/);
  assert.throws(() => applyWorldOutput(pending, finish, { ...source, id: 's2', speakerId: 'b', speechIndex: 2 }, ['a', 'b']), /시간이 되지/);
  const stolen = silent(); stolen.events.push({ type: 'actor_result', npcId: 'b', text: 'B가 공을 받았다', evidence: '공을 던진다.', processId: null });
  assert.throws(() => applyWorldOutput(state, stolen, source, ['a', 'b']), /현재 화자/);
  stolen.events[0] = { type: 'physical_effect', npcId: 'b', text: '공에 맞았다', evidence: null, processId: 'ball' };
  assert.throws(() => applyWorldOutput(pending, stolen, source, ['a', 'b']), /반응 기회/);
  stolen.events[0].npcId = 'stranger'; assert.throws(() => applyWorldOutput(pending, stolen, source, ['a', 'b']), /알 수 없는 NPC/);
  assert.equal(state.processes.length, 0); assert.equal(pending.virtualSeconds, 1); // immutable on failure
  const allowed = silent(2); allowed.events.push({ type: 'physical_effect', npcId: 'b', text: '공이 B의 어깨에 닿았다.', evidence: null, processId: 'ball' }); allowed.finishProcesses = finish.finishProcesses;
  const resolved = applyWorldOutput(pending, allowed, { ...source, speakerId: 'b', action: '공을 받지 않고 지켜본다.' }, ['a', 'b']);
  assert.equal(resolved.state.processes[0].status, 'completed'); // opportunity is not forced cooperation
});

test('step covers world outcome; transaction failure reuses completed engine call; injected events reach next tick', async () => {
  const store = new Store(':memory:'), adapter = new MockAdapter(), engine = new Engine(store, adapter, '.cache/world-step');
  adapter.delayMs = 1; scripted(adapter); const put = store.put.bind(store); let fail = true;
  store.put = ((table: any, value: any) => { if (table === 'utterances' && value.worldEvent && fail) { fail = false; throw new Error('world transaction interrupted'); } return put(table, value); }) as typeof store.put;
  try {
    const { runs: [run] } = await engine.create(specFor(), false);
    await engine.resume(run.id, true); await engine.idle(); let d = engine.detail(run.id);
    assert.equal(d.run.status, 'paused'); assert.match(d.run.error!, /transaction/); assert.equal(d.summary.speechCount, 1);
    assert.equal(d.run.worldState, undefined); assert.equal(d.utterances.filter(u => u.worldEvent).length, 0);
    await engine.inject(run.id, '公開介入_MARKER');
    await engine.resume(run.id, true); await engine.idle(); d = engine.detail(run.id);
    assert.equal(d.summary.speechCount, 2); assert.equal(d.summary.byKind.environment.calls, 2);
    assert.equal(d.run.status, 'paused'); assert.equal(d.run.worldState?.processedSpeechCount, 2);
    assert.equal(d.run.worldState?.virtualSeconds, 3);
    assert.ok(JSON.parse(d.invocations.filter(c => c.kind === 'environment')[1].input).publicChanges.some((u: any) => u.speech === '公開介入_MARKER'));
    assert.equal(store.events(run.id).filter(e => e.method === 'world/committed').length, 2);
  } finally { await engine.close(); store.close(); }
});

test('uncertain world call is reconciled after restart without repeating speech or spending a second call', async () => {
  const store = new Store(':memory:'), adapter = new MockAdapter(); let engine = new Engine(store, adapter, '.cache/world-recovery');
  adapter.delayMs = 1; const turn = adapter.turn.bind(adapter); let interrupt = true;
  adapter.turn = async (...args) => { const result = await turn(...args); if (JSON.parse(args[0].input).task === 'environment' && interrupt) { interrupt = false; throw new Error('disconnected'); } return result; };
  try {
    const spec = specFor(); spec.maxUtterances = 1;
    const { runs: [run] } = await engine.create(spec); await engine.idle();
    assert.equal(engine.detail(run.id).invocations.at(-1)?.status, 'uncertain');
    await engine.close(); engine = new Engine(store, adapter, '.cache/world-recovery');
    const reconcile = adapter.reconcile.bind(adapter); adapter.reconcile = async () => null;
    await assert.rejects(engine.resume(run.id), /자동 재전송하지/); assert.equal(adapter.requests.length, 2);
    adapter.reconcile = reconcile; await engine.resume(run.id); await engine.idle(); const d = engine.detail(run.id);
    assert.equal(d.run.status, 'completed'); assert.equal(d.summary.speechCount, 1); assert.equal(d.summary.byKind.environment.calls, 1);
    assert.equal(adapter.requests.length, 2); assert.equal(d.run.worldState?.processedSpeechCount, 1);
  } finally { await engine.close(); store.close(); }
});

test('separate concurrent bundles and director/reinjection keep world helpers private and silent results out of dialogue', async () => {
  const store = new Store(':memory:'), adapter = new MockAdapter(), engine = new Engine(store, adapter, '.cache/world-isolation');
  adapter.delayMs = 1;
  try {
    const spec = specFor(); spec.maxUtterances = 3; spec.repetitions = 2;
    spec.variants[0].turnPolicy = 'director'; spec.variants[0].memoryMode = 'reinject_on_speech';
    const { runs } = await engine.create(spec); await engine.idle();
    const details = runs.map(r => engine.detail(r.id));
    assert.notEqual(details[0].run.helperSessions['world-engine'].threadId, details[1].run.helperSessions['world-engine'].threadId);
    for (const d of details) {
      assert.equal(d.run.status, 'completed', d.run.error ?? ''); assert.equal(d.utterances.length, 3);
      assert.equal(d.summary.byKind.environment.calls, 3); assert.equal(d.summary.byKind.director.calls, 2);
      for (const c of d.invocations.filter(c => c.kind === 'environment')) assert.ok(d.utterances.some(u => u.id === c.sourceUtteranceId));
      for (const c of d.invocations.filter(c => c.kind === 'speech')) assert.ok(JSON.parse(c.input).originalCharacterAndWorld.includes('세계 엔진'));
      for (const c of d.invocations.filter(c => c.kind === 'environment')) assert.ok(!c.input.includes('PRIVATE_'));
    }
  } finally { await engine.close(); store.close(); }
});

test('AI config requires engine model, section JSON round trips, legacy defaults preserved', () => {
  const spec = specFor(); assert.equal(environmentMode(spec, spec.variants[0]), 'ai');
  assert.equal(environmentMode(exampleSpec('mock-model')), 'rules');
  assert.equal(applyConfigSection(spec, 'conditions', readConfigSection(spec, 'conditions')).worldEngine?.effort, 'medium');
  spec.scenario.worldEngineInstructions = '연락은 즉답하지 않는다.';
  assert.equal(applyConfigSection(spec, 'world', readConfigSection(spec, 'world')).scenario.worldEngineInstructions, spec.scenario.worldEngineInstructions);
  delete spec.worldEngine; assert.throws(() => experimentSchema.parse(spec), /세계 엔진의 모델/);
  const input = JSON.parse(worldPrompt(spec, initialWorldState(), [source], source));
  assert.ok(!JSON.stringify(input).includes('PRIVATE_'));
});

test('last speech still triggers engine; urgent reactions and future events remain pending at the speech limit', async () => {
  const store = new Store(':memory:'), adapter = new MockAdapter(), engine = new Engine(store, adapter, '.cache/world-last');
  scripted(adapter); adapter.delayMs = 1;
  try {
    const spec = specFor('per_utterance'); spec.maxUtterances = 1;
    const { runs: [run] } = await engine.create(spec); await engine.idle(); const d = engine.detail(run.id);
    assert.equal(d.run.status, 'completed'); assert.equal(d.summary.speechCount, 1);
    assert.equal(d.summary.byKind.environment.calls, 1); assert.equal(d.summary.pendingReceipts, 0);
    assert.deepEqual(d.run.worldState?.processes[0].waitingNpcIds, ['miru']);
    assert.equal(d.run.worldState?.processes[1].status, 'pending');
  } finally { await engine.close(); store.close(); }
});

test('invalid world output pauses without leaking it, and retries only the engine with a validation reason', async () => {
  const store = new Store(':memory:'), adapter = new MockAdapter(), engine = new Engine(store, adapter, '.cache/world-invalid');
  adapter.delayMs = 1; const turn = adapter.turn.bind(adapter); let bad = true;
  adapter.turn = async (...args) => {
    const result = await turn(...args); const input = JSON.parse(args[0].input);
    if (input.task === 'environment' && bad) { bad = false; const out = silent(); out.events.push({ type: 'actor_result', npcId: 'miru', text: '미루가 받았다.', evidence: '없는 행동', processId: null }); result.output = JSON.stringify(out); }
    return result;
  };
  try {
    const spec = specFor(); spec.maxUtterances = 1;
    const { runs: [run] } = await engine.create(spec); await engine.idle(); let d = engine.detail(run.id);
    assert.equal(d.run.status, 'paused'); assert.equal(d.utterances.length, 1); assert.equal(d.run.worldState, undefined);
    assert.equal(d.invocations.at(-1)?.status, 'failed');
    await engine.resume(run.id); await engine.idle(); d = engine.detail(run.id);
    assert.equal(d.run.status, 'completed'); assert.equal(d.summary.speechCount, 1); assert.equal(d.summary.byKind.environment.calls, 2);
    const retry = d.invocations.at(-1)!; assert.ok(retry.retryOf); assert.match(JSON.parse(retry.input).previousFailure, /현재 화자/);
    assert.ok(!JSON.parse(retry.input).currentAction);
  } finally { await engine.close(); store.close(); }
});

test('world event receiver failure preserves completed engine output and retries only missing deliveries', async () => {
  const store = new Store(':memory:'), adapter = new MockAdapter(), engine = new Engine(store, adapter, '.cache/world-delivery');
  adapter.delayMs = 1; scripted(adapter); const turn = adapter.turn.bind(adapter); let fail = true;
  adapter.turn = async (...args) => {
    const input = JSON.parse(args[0].input);
    if (input.task === 'receive' && input.message?.kind==='event' && input.message.observation && fail) { fail = false; adapter.failNextKind = 'receive'; }
    return turn(...args);
  };
  try {
    const spec = specFor('per_utterance'); spec.maxUtterances = 1;
    const { runs: [run] } = await engine.create(spec); await engine.idle(); let d = engine.detail(run.id);
    assert.equal(d.run.status, 'paused'); assert.equal(d.summary.byKind.environment.calls, 1); assert.equal(d.run.worldState?.processedSpeechCount, 1);
    const completed = d.receipts.filter(r => r.status === 'delivered').map(r => r.invocationId);
    await engine.resume(run.id); await engine.idle(); d = engine.detail(run.id);
    assert.equal(d.run.status, 'completed'); assert.equal(d.summary.byKind.environment.calls, 1); assert.equal(d.summary.pendingReceipts, 0);
    assert.equal(d.summary.byKind.receive.calls, 6); // 2 speech + 3 outcome + 1 retry
    assert.ok(completed.every(id => d.receipts.some(r => r.invocationId === id)));
  } finally { await engine.close(); store.close(); }
});
