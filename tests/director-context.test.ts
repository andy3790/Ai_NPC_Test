import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Engine } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
import { DIRECTOR_CONTEXT, legacyDirectorInstructions, directorInstructions, directorObservations, directorOutputSchema, directorPrompt } from '../src/core/director.js';
import { MockAdapter } from '../src/adapters/mock.js';
import { OpenAIAdapter } from '../src/adapters/openai.js';
import { exampleSpec } from '../src/shared/example.js';
import { spatialExample } from '../src/shared/spatial-example.js';
import type { Utterance } from '../src/shared/types.js';
import { openaiFixture, requestInput } from './fixtures/openai.js';

function record(sequence: number, overrides: Partial<Utterance> = {}): Utterance {
  return { id: `message-${sequence}`, runId: 'test', sequence, speechIndex: sequence, kind: 'speech',
    speakerId: 'yoon', speakerName: '윤', speech: `발언 ${sequence}`, action: '', createdAt: new Date().toISOString(),
    invocationId: null, deliveryCompletedAt: null, deliveryMs: null, ...overrides };
}
function setup(spatial = false) {
  const store = new Store(':memory:'), adapter = new MockAdapter(); adapter.delayMs = 0;
  const spec = spatial ? spatialExample('mock-model') : exampleSpec('mock-model');
  delete spec.scenario.environment;
  spec.variants = [{ ...spec.variants[0], turnPolicy: 'director' }];
  spec.evaluation.enabled = false; spec.maxUtterances = 8;
  return { store, adapter, spec, engine: new Engine(store, adapter, '.cache/director-test') };
}

test('director input stays bounded over 10,000 messages, preserving recent questions and old speaker wait counts', () => {
  const characters = exampleSpec('mock-model').scenario.characters;
  const history = Array.from({ length: 10_000 }, (_, n) => record(n + 1, {
    speakerId: n === 0 ? 'miru' : 'yoon', speech: `발언-${n + 1}: ` + '긴 대화 '.repeat(1000), action: '행동 '.repeat(1000),
  }));
  history.at(-1)!.speech = '도하, 다음은 어떻게 하면 좋겠어?';
  const { input, metadata } = directorPrompt({ characters, allowedSpeakerIds: ['doha', 'miru'], history, speeches: history });
  const parsed = JSON.parse(input);
  assert.ok(input.length <= DIRECTOR_CONTEXT.maxInputCharacters);
  assert.ok(JSON.stringify(parsed.history).length <= DIRECTOR_CONTEXT.maxHistoryCharacters);
  assert.ok(parsed.history.length <= DIRECTOR_CONTEXT.maxMessages);
  assert.equal(parsed.history.at(-1).speech, history.at(-1)!.speech);
  assert.ok(parsed.history.every((u: any) => u.sequence > 9992));
  assert.equal(parsed.participants.find((c: any) => c.id === 'miru').turnsSinceLastSpeech, 9999);
  assert.equal(parsed.participants.find((c: any) => c.id === 'doha').turnsSinceLastSpeech, null);
  assert.equal(parsed.participants.find((c: any) => c.id === 'yoon').turnsSinceLastSpeech, 0);
  assert.equal(metadata.directorContext.truncated, true);
  assert.ok(!input.includes('personality') && !input.includes(characters[0].memories));
});

test('escaped text, long IDs, maximum candidates and surrogate pairs respect serialized character budgets', () => {
  const characters = Array.from({ length: 30 }, (_, i) => ({ id: `npc${i}`.padEnd(100, 'x'), name: '\u0001'.repeat(100) }));
  const history = Array.from({ length: 120 }, (_, n) => record(n + 1, {
    speakerId: characters[n % 30].id, speakerName: characters[0].name,
    speech: '\u0001'.repeat(10_000), action: '😀'.repeat(10_000),
  }));
  const { input } = directorPrompt({ characters, allowedSpeakerIds: characters.map(c => c.id), history, speeches: history,
    location: 'x'.repeat(100), initialScene: '\u0001😀'.repeat(10_000) });
  const parsed = JSON.parse(input);
  assert.equal(parsed.allowedSpeakerIds.length, 30); assert.equal(parsed.participants.length, 30);
  assert.ok(input.length <= DIRECTOR_CONTEXT.maxInputCharacters);
  assert.ok(JSON.stringify(parsed.history).length <= DIRECTOR_CONTEXT.maxHistoryCharacters);
  assert.equal(parsed.history.at(-1).sequence, 120);
  assert.ok(parsed.history.every((u: any) => u.action.isWellFormed()));
  assert.ok(parsed.initialScene.isWellFormed());
  assert.ok(JSON.stringify(parsed.initialScene).length <= DIRECTOR_CONTEXT.maxInitialSceneCharacters);
});

test('spatial director receives local observations and incoming remote speech, not unrelated speech or remote actions', () => {
  const local = record(1, { speakerId: 'yoon' });
  const remote = record(2, { speakerId: 'serin', speech: '무전 응답을 기다려요.', action: 'REMOTE_UNSEEN_ACTION',
    perception: { locationId: 'workshop', virtualSeconds: 1, speechRecipientIds: ['miru'], actionRecipientIds: ['other'] } });
  const unrelated = record(3, { speakerId: 'serin', speech: 'UNRELATED_SECRET',
    perception: { locationId: 'workshop', virtualSeconds: 2, speechRecipientIds: ['other'], actionRecipientIds: [] } });
  const observations = directorObservations([local, remote, unrelated], ['yoon', 'miru']);
  assert.deepEqual(observations.map(u => u.id), [local.id, remote.id]);
  assert.equal(observations[1].action, ''); assert.equal(observations[1].speech, remote.speech);
  assert.equal(remote.action, 'REMOTE_UNSEEN_ACTION', 'source record remains unchanged');
});

test('director v4 includes public opening context while v3 replay and private profiles stay isolated', () => {
  const characters = exampleSpec('mock-model').scenario.characters.map(c => ({ ...c, memories: 'PRIVATE_PROFILE_SENTINEL' }));
  const history = [record(1, { speech: '여기 표시한 게 궁금한 거예요?' })];
  const options = { characters, allowedSpeakerIds: ['doha', 'miru'], history, speeches: history,
    initialScene: '미루가 고지서를 가져왔고 도하는 옆에 앉은 동행이다.' };
  const current = directorPrompt(options), legacy = directorPrompt({ ...options, version: 'director/3' });
  assert.equal(JSON.parse(current.input).initialScene, options.initialScene);
  assert.equal(JSON.parse(legacy.input).initialScene, undefined);
  assert.equal(current.metadata.directorContext.version, 'director/4');
  assert.equal(legacy.metadata.directorContext.version, 'director/3');
  assert.doesNotMatch(current.input + current.instructions, /PRIVATE_PROFILE_SENTINEL/);
  assert.equal(current.instructions, directorInstructions);
  assert.equal(createHash('sha256').update(directorInstructions).digest('hex'), '9075d7ea75d0d4f386273e47a73cb304a1e478205f13c687812c784125021971');
  assert.equal(legacy.instructions, legacyDirectorInstructions);
  assert.deepEqual(current.outputSchema, legacy.outputSchema);
  assert.deepEqual(JSON.parse(current.input).history, JSON.parse(legacy.input).history);
});

test('120-turn run uses bounded fresh director sessions while NPC sessions and fairness remain intact', async () => {
  const { engine, store, adapter, spec } = setup(); spec.maxUtterances = 120;
  const turn = adapter.turn.bind(adapter);
  adapter.turn = async (...args) => {
    const result = await turn(...args);
    if (JSON.parse(args[0].input).task === 'speak') result.output = JSON.stringify({ speech: '현재 질문을 이어갑니다. '.repeat(100), action: '주변을 살펴본다. '.repeat(50) });
    return result;
  };
  try {
    const { runs: [run] } = await engine.create(spec); await engine.idle(); const d = engine.detail(run.id);
    assert.equal(d.run.status, 'completed', d.run.error ?? ''); assert.equal(d.summary.speechCount, 120);
    const calls = d.invocations.filter(c => c.kind === 'director'); assert.equal(calls.length, 119);
    assert.equal(new Set(calls.map(c => c.threadId)).size, calls.length);
    assert.equal(Object.keys(d.run.helperSessions).length, 1, 'helper pointers do not grow per decision');
    for (const c of calls) {
      const p = JSON.parse(c.input), m = c.metadata.directorContext as any;
      assert.ok(c.input.length <= DIRECTOR_CONTEXT.maxInputCharacters);
      assert.ok(p.history.length <= DIRECTOR_CONTEXT.maxMessages);
      assert.ok(JSON.stringify(p.history).length <= DIRECTOR_CONTEXT.maxHistoryCharacters);
      assert.equal(m.inputCharacters, c.input.length); assert.equal(m.sessionMode, 'fresh_per_attempt');
    }
    assert.ok(Math.abs(calls[15].input.length - calls.at(-1)!.input.length) < 100, 'late prompts stay at the same scale');
    assert.equal(new Set(d.invocations.filter(c => c.kind === 'speech').map(c => c.threadId)).size, 3);
    for (let i = 1; i < d.utterances.length; i++) assert.notEqual(d.utterances[i - 1].speakerId, d.utterances[i].speakerId);
    for (const character of spec.scenario.characters) assert.equal(d.utterances.filter(u => u.speakerId === character.id).length, 40);
  } finally { await engine.close(); store.close(); }
});

test('a forced waiting speaker takes the turn without a director request', async () => {
  const { engine, store, adapter, spec } = setup(); spec.maxUtterances = 9;
  const turn = adapter.turn.bind(adapter);
  adapter.turn = async (...args) => {
    const request = args[0], p = JSON.parse(request.input), result = await turn(...args);
    if (p.task === 'direct') {
      const schema = request.outputSchema as any;
      assert.deepEqual(schema.properties.speakerId.enum, p.allowedSpeakerIds);
      // Keep the first pair talking until the real scheduler offers the third.
      const pair = p.allowedSpeakerIds.find((id: string) => id === 'yoon' || id === 'doha');
      assert.ok(pair, 'a sole eligible actor should be selected by the scheduler');
      result.output = JSON.stringify({ speakerId: pair, reason: 'Reply to the pair' });
    }
    return result;
  };
  try {
    const { runs: [run] } = await engine.create(spec); await engine.idle(); const d = engine.detail(run.id);
    assert.equal(d.run.status,'completed');
    assert.equal(d.utterances.filter(u => u.kind === 'speech')[5].speakerId,'miru');
    assert.ok(d.invocations.filter(c => c.kind === 'director').every(c => JSON.parse(c.input).allowedSpeakerIds.length > 1));
    assert.equal(createHash('sha256').update(legacyDirectorInstructions).digest('hex'), '5cbf1f16ab0e054b6f2f09f157136cd308ed26c04ccd2b876d99cec2707c1b92');
  } finally { await engine.close(); store.close(); }
});

test('failed director retry gets the full bounded input in a fresh session and preserves attempt accounting', async () => {
  const { engine, store, adapter, spec } = setup(); adapter.failNextKind = 'direct';
  try {
    const { runs: [run] } = await engine.create(spec); await engine.idle();
    const failed = engine.detail(run.id).invocations.find(c => c.kind === 'director')!;
    assert.equal(failed.status, 'failed'); assert.equal(engine.run(run.id).status, 'paused');
    await engine.resume(run.id); await engine.idle(); const d = engine.detail(run.id);
    assert.equal(d.run.status, 'completed', d.run.error ?? '');
    const retry = d.invocations.find(c => c.retryOf === failed.id)!;
    assert.notEqual(retry.threadId, failed.threadId); assert.equal(retry.attempt, 2);
    assert.deepEqual(JSON.parse(retry.input), JSON.parse(failed.input));
    assert.equal(JSON.parse(retry.input).previousFailure, undefined);
  } finally { await engine.close(); store.close(); }
});

for (const spatial of [false, true]) test(`${spatial ? 'spatial' : 'single-room'} director restart reconciles uncertain decisions without reissuing them`, async () => {
  const fixture = setup(spatial); const { store, adapter, spec } = fixture; let engine = fixture.engine;
  const turn = adapter.turn.bind(adapter); let once = true;
  adapter.turn = async (...args) => {
    const result = await turn(...args);
    if (JSON.parse(args[0].input).task === 'direct' && once) { once = false; throw new Error('disconnect after decision'); }
    return result;
  };
  try {
    const { runs: [run] } = await engine.create(spec); await engine.idle();
    const uncertain = engine.detail(run.id).invocations.find(c => c.status === 'uncertain')!;
    assert.equal(uncertain.kind, 'director'); const requests = adapter.requests.length;
    await engine.close(); engine = new Engine(store, adapter, '.cache/director-test');
    const reconcile = adapter.reconcile.bind(adapter); adapter.reconcile = async () => null;
    await assert.rejects(engine.resume(run.id), /자동 재전송하지/); assert.equal(adapter.requests.length, requests);
    adapter.reconcile = reconcile; await engine.resume(run.id); await engine.idle(); const d = engine.detail(run.id);
    assert.equal(d.run.status, 'completed', d.run.error ?? '');
    assert.equal(d.invocations.filter(c => c.operationKey === uncertain.operationKey).length, 1);
    const directors = d.invocations.filter(c => c.kind === 'director');
    assert.equal(new Set(directors.map(c => c.threadId)).size, directors.length);
    assert.ok(directors.every(c => c.input.length <= DIRECTOR_CONTEXT.maxInputCharacters));
  } finally { await engine.close(); store.close(); }
});

for (const spatial of [false, true]) test(`OpenAI ${spatial ? 'spatial' : 'single-room'} directors never chain previous responses; NPC context uses confirmed observations and metrics are retained`, async () => {
  await mkdir('.cache', { recursive: true }); const root = await mkdtemp(resolve('.cache/director-api-'));
  const api = openaiFixture(), store = new Store(':memory:'), adapter = new OpenAIAdapter(root, { apiKey: api.key, fetch: api.fetch });
  const engine = new Engine(store, adapter, root);
  const spec = spatial ? spatialExample('gpt-6-luna') : exampleSpec('gpt-6-luna'); delete spec.scenario.environment;
  spec.scenario.situation = 'PUBLIC_OPENING_SCENE';
  spec.scenario.characters[0].memories = 'PRIVATE_PROFILE_SENTINEL';
  spec.scenario.worldEngineInstructions = 'WORLD_ENGINE_PRIVATE_SENTINEL';
  if (spatial) spec.scenario.spatial!.initialPositions = spec.scenario.characters.map(c => ({ npcId: c.id, locationId: c.id === 'serin' ? 'workshop' : 'lounge' }));
  spec.variants = [{ ...spec.variants[0], turnPolicy: 'director' }]; spec.maxUtterances = 16; spec.evaluation.enabled = false;
  try {
    const { runs: [run] } = await engine.create(spec); await engine.idle(); const d = engine.detail(run.id);
    assert.equal(d.run.status, 'completed', d.run.error ?? '');
    const calls = d.invocations.filter(c => c.kind === 'director'); assert.ok(calls.length > 2);
    for (const c of calls) {
      const request = api.requests.find(b => b.metadata.npc_lab_call_id === c.id);
      assert.equal(request.previous_response_id, null); assert.equal(request.input, c.input);
      const allowed = JSON.parse(c.input).allowedSpeakerIds;
      assert.equal(JSON.parse(c.input).initialScene, spatial ? undefined : spec.scenario.situation);
      assert.doesNotMatch(c.input, /PRIVATE_PROFILE_SENTINEL|WORLD_ENGINE_PRIVATE_SENTINEL/);
      if (spatial) assert.doesNotMatch(c.input, /PUBLIC_OPENING_SCENE/);
      assert.deepEqual(request.text.format.schema.properties.speakerId.enum, allowed);
      assert.equal(c.metadata.outputSchemaSha256, createHash('sha256').update(JSON.stringify(directorOutputSchema(allowed))).digest('hex'));
      assert.equal(c.usage.totalTokens, 120); assert.ok(c.durationMs! >= 0); assert.ok(c.firstOutputMs! >= 0);
    }
    const npc = api.requests.filter(b => requestInput(b).task === 'speak');
    assert.ok(npc.length && npc.every(b => b.previous_response_id === null));
    assert.ok(npc.some(b => requestInput(b).earlierObservations?.length));
    assert.equal(d.summary.byKind.director.tokens.totalTokens, calls.length * 120);
  } finally { await engine.close(); store.close(); }
});
