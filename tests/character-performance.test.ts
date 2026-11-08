import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Engine } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
import { withSceneChoice } from '../src/core/scene-flow.js';
import { MockAdapter } from '../src/adapters/mock.js';
import { committedPerformance, earlierWords, performanceInstructions, performTurn, rhythmInstruction, withPortrayal } from '../src/core/character-performance.js';
import { characterSchema, outputSchemas } from '../src/shared/schema.js';
import { CHARACTER_PERFORMANCE } from '../src/shared/character-performance.js';
import { exampleSpec } from '../src/shared/example.js';
import { spatialExample } from '../src/shared/spatial-example.js';
import { applyConfigSection } from '../src/shared/config-sections.js';
import type { InvocationMetrics, Utterance } from '../src/shared/types.js';

const hash = (value: object) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function smallSpec() {
  const spec = exampleSpec('mock-model'); delete spec.scenario.environment;
  spec.scenario.characters = [characterSchema.parse({ id: 'one', name: '연', personality: '신중하다.' }),
    characterSchema.parse({ id: 'two', name: '훈', speechStyle: '말을 하며 생각한다.', knowledge: 'PRIVATE_TEST_MARKER' })];
  spec.maxUtterances = 5; spec.variants = [spec.variants[0]]; spec.evaluation.enabled = false;
  return spec;
}

test('short and name-only profiles work in the same JSON entry point as fully authored characters', () => {
  const spec = smallSpec();
  const revised = applyConfigSection(spec, 'characters', [{ id: 'a', name: '다' }, { id: 'b', name: '라', personality: '호기심이 많다.' }]);
  assert.equal(revised.scenario.characters[1].speechStyle, '');
  const cues = Array.from({ length: 30 }, (_, slot) => performTurn(CHARACTER_PERFORMANCE, revised.scenario.characters[0], slot, {}, []));
  assert.equal(new Set(cues.map(cue => JSON.stringify(cue.context))).size, 30);
  assert.ok(cues.every(c => !c.select));
  assert.equal(performTurn(CHARACTER_PERFORMANCE, revised.scenario.characters[1], 1, {}, []).select, true);
});

test('revisions freeze their instructions and a missing provider choice cannot overwrite authored character facts', () => {
  const digest = (text: string) => createHash('sha256').update(text).digest('hex');
  assert.equal(digest(performanceInstructions), '2996a68465ad2688638e6594e4c04e6c56cfe8e1bceff9cae6fdcaaeba9c083e');
  assert.equal(digest(rhythmInstruction), 'f69da31d353da53c51d54955fd344f41670e79218b8e9336020dce3e114d33a3');
  const authored = smallSpec().scenario.characters[0];
  assert.equal(performTurn('character-performance/1', authored, 0, {}, []).context.possiblePhrasing, undefined);
  assert.ok(performTurn(CHARACTER_PERFORMANCE, authored, 0, {}, []).context.possiblePhrasing);
  const call = { id: 'first', output: '{"speech":"응","action":"","portrayal":{"attention":"invented"}}' } as InvocationMetrics;
  const fallback = committedPerformance(CHARACTER_PERFORMANCE, authored, 0, call);
  assert.equal(fallback.source, 'fallback'); assert.equal(fallback.choices, undefined);
  assert.deepEqual(performTurn(CHARACTER_PERFORMANCE, authored, 0, { performance: fallback }, []).context, {});
  assert.equal(committedPerformance(CHARACTER_PERFORMANCE, characterSchema.parse({ id: 'blank', name: '린' }), 0, call).source, 'unspecified');
});

test('a committed portrayal survives restart and stays confined to its actor in both delivery modes', async () => {
  for (const deliveryMode of ['batched_on_turn', 'per_utterance'] as const) {
    const store = new Store(':memory:'), adapter = new MockAdapter(); adapter.delayMs = 0;
    let engine = new Engine(store, adapter, '.cache/history-test-character');
    try {
      const spec = smallSpec(); spec.variants[0].deliveryMode = deliveryMode;
      const { runs: [created] } = await engine.create(spec, false);
      assert.equal(created.variant.characterPerformanceVersion, CHARACTER_PERFORMANCE);
      await engine.resume(created.id, true); await engine.idle();
      const firstState = engine.run(created.id).sessions.one.performance!;
      assert.equal(firstState.source, 'profile');
      await engine.close(); engine = new Engine(store, adapter, '.cache/history-test-character');
      await engine.resume(created.id); await engine.idle();
      const d = engine.detail(created.id);
      assert.equal(d.run.status, 'completed', d.run.error ?? '');
      assert.deepEqual(d.run.sessions.one.performance, firstState);
      assert.equal(d.invocations.filter(c => c.kind === 'speech').length, spec.maxUtterances);
      for (const c of d.invocations) {
        const payload = JSON.parse(c.input);
        if (c.kind === 'receive') {
          assert.equal(payload.characterPerformance, undefined);
          assert.doesNotMatch(c.input, /PRIVATE_TEST_MARKER|portrayal|phrasing/);
        } else {
          const state = d.run.sessions[c.characterId!].performance!;
          if (state.invocationId === c.id) assert.ok(payload.characterPerformance.select);
          else {
            assert.equal(c.metadata.performanceSourceInvocationId, state.invocationId);
            assert.equal(payload.characterPerformance.phrasing, state.choices!.phrasing);
          }
          const portrayal=state.invocationId === c.id ? withPortrayal(outputSchemas.speech) : outputSchemas.speech;
          const observed=(payload.sceneNow.changes ?? []).map((e:{sequence:number})=>e.sequence);
          assert.equal(c.metadata.outputSchemaSha256, hash(withSceneChoice(portrayal,observed)));
        }
      }
      assert.doesNotMatch(JSON.stringify(d.utterances), /PRIVATE_TEST_MARKER|portrayal|phrasing/);
    } finally { await engine.close(); store.close(); }
  }
});

test('rollback of a first choice also rolls back the private interpretation; replay reuses the accepted call', async () => {
  const store = new Store(':memory:'), adapter = new MockAdapter(); adapter.delayMs = 0;
  const engine = new Engine(store, adapter, '.cache/history-test-character');
  try {
    let fail = true; const put = store.put.bind(store);
    store.put = (table, record) => { if (table === 'utterances' && fail) { fail = false; throw Error('simulated commit failure'); } return put(table, record); };
    const { runs: [run] } = await engine.create(smallSpec()); await engine.idle();
    const first = store.list('invocations', run.id)[0];
    assert.equal(first.status, 'completed'); assert.equal(engine.run(run.id).sessions.one.performance, undefined);
    await engine.resume(run.id); await engine.idle();
    assert.equal(engine.run(run.id).sessions.one.performance?.invocationId, first.id);
    assert.equal(store.list('invocations', run.id).filter(c => c.operationKey === first.operationKey).length, 1);
  } finally { await engine.close(); store.close(); }
});

test('historical runs with no pinned engine version keep their original input and speech schema', async () => {
  const store = new Store(':memory:'), adapter = new MockAdapter(); adapter.delayMs = 0;
  const engine = new Engine(store, adapter, '.cache/history-test-character');
  try {
    const { runs: [run] } = await engine.create(smallSpec(), false);
    const variant = { ...run.variant }; delete variant.characterPerformanceVersion;
    store.patch('runs', run.id, { variant, promptVersion: 'npc-lab/10',sceneFlowVersion:undefined });
    await engine.resume(run.id); await engine.idle();
    const d = engine.detail(run.id);
    assert.ok(d.invocations.every(c => JSON.parse(c.input).characterPerformance === undefined && c.metadata.outputSchemaSha256 === hash(outputSchemas.speech)));
    assert.ok(Object.values(d.run.sessions).every(s => !s.performance && !s.instructions.includes('characterPerformance')));
  } finally { await engine.close(); store.close(); }
});

test('retrieval follows explicit subject returns and visible observations; quotes are complete and attributed', () => {
  const line = (id: string, speakerId: string, speech: string) => ({ id, speakerId, speech, action: '', kind: 'speech' } as Utterance);
  const one = line('first', 'self', '저는 통밀빵으로 할게요.');
  const newer = line('new', 'self', '통밀빵은 반만 먹을래요.');
  const ask = line('asked', 'other', '아까 통밀빵 다시 드릴까요?');
  assert.deepEqual(earlierWords([one, newer, ask], 'self'), { id: 'new', speech: newer.speech });
  assert.equal(earlierWords([one, line('other', 'other', '난방 더 줄일까요?')], 'self'), undefined);
  assert.equal(earlierWords([one, { ...ask, perception: { locationId: 'room', virtualSeconds: 0, speechRecipientIds: ['else'], actionRecipientIds: ['self'] } }], 'self'), undefined);
});

test('rule and spatial choices retain their contracts and do not expose private portrayal to world helpers', async () => {
  for (const spec of [exampleSpec('mock-model'), spatialExample('mock-model')]) {
    spec.maxUtterances = 4; spec.variants = [spec.variants[0]]; spec.evaluation.enabled = false;
    const store = new Store(':memory:'), adapter = new MockAdapter(); adapter.delayMs = 0;
    const engine = new Engine(store, adapter, '.cache/history-test-character');
    try {
      const { runs: [run] } = await engine.create(spec); await engine.idle();
      const d = engine.detail(run.id); assert.equal(d.run.status, 'completed', d.run.error ?? '');
      const spatial = run.variant.environmentMode === 'ai_spatial';
      const first = d.invocations.find(c => c.kind === 'speech')!;
      assert.equal(first.metadata.outputSchemaSha256, hash(withSceneChoice(withPortrayal(spatial ? outputSchemas.spatialSpeech : outputSchemas.progressSpeech),[])));
      for (const c of d.invocations.filter(c => c.kind !== 'speech')) assert.doesNotMatch(c.input, /characterPerformance|portrayal|phrasing/);
      assert.doesNotMatch(JSON.stringify(d.utterances), /portrayal|phrasing/);
    } finally { await engine.close(); store.close(); }
  }
});
