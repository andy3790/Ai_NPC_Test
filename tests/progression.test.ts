import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/core/store.js';
import { Engine } from '../src/core/engine.js';
import { MockAdapter } from '../src/adapters/mock.js';
import { exampleSpec } from '../src/shared/example.js';
import { experimentSchema } from '../src/shared/schema.js';
import { progression, resolveAction } from '../src/core/progression.js';
import { repetitionMetrics } from '../src/core/quality.js';
import { exportFiles } from '../src/core/export.js';
import type { Utterance } from '../src/shared/types.js';

for (const mode of ['batched_on_turn', 'per_utterance'] as const) test(`${mode}: authored outcomes advance goals, stop early, preserve barriers and export quality`, async () => {
  const store = new Store(':memory:'), adapter = new MockAdapter(), engine = new Engine(store, adapter, '.cache/progression');
  adapter.delayMs = 1;
  try {
    const spec = exampleSpec('mock-model'); spec.variants = [{ ...spec.variants[0], deliveryMode: mode }];
    const { runs } = await engine.create(spec); await engine.idle(); const d = engine.detail(runs[0].id);
    assert.equal(d.run.status, 'completed', d.run.error ?? ''); assert.equal(d.run.completionReason, 'goals_achieved');
    assert.equal(d.summary.speechCount, 12); assert.equal(d.summary.quality.progression.achievedGoals, 3);
    const results = d.utterances.filter(u => u.resolution);
    assert.equal(results.length, 8); assert.equal(new Set(results.map(u => u.resolution!.actionId)).size, 8);
    assert.ok(results.every(u => d.utterances.some(s => s.id === u.resolution!.sourceUtteranceId && s.sequence + 1 === u.sequence)));
    assert.ok(d.invocations.filter(c => c.kind === 'receive').every(c => !JSON.parse(c.input).environment));
    assert.deepEqual(d.evaluations.map(e => [e.from, e.to]), [[1, 10], [11, 12]]);
    const finalJudge = JSON.parse(d.invocations.filter(c => c.kind === 'evaluation').at(-1)!.input);
    assert.equal(finalJudge.progress.allGoalsAchieved, true); assert.ok(finalJudge.history.at(-1).resolution);
    if (mode === 'per_utterance') {
      assert.equal(d.summary.byKind.receive.calls, 12 * 2 + 8 * 3); assert.equal(d.summary.pendingReceipts, 0);
      for (const u of d.utterances) {
        const next = d.utterances.find(s => s.sequence > u.sequence && s.kind === 'speech');
        if (next) assert.ok(d.invocations.filter(c => c.sourceUtteranceId === u.id).every(c => c.completedAt! <= d.invocations.find(c => c.id === next.invocationId)!.startedAt!));
      }
    }
    const files = exportFiles(d, store.events(d.run.id));
    assert.equal(JSON.parse(files['quality.json']).progression.achievedGoals, 3);
    assert.ok(files['goals.csv'].includes('firstAchievedAtSpeech')); assert.ok(files['repetition.csv'].includes('similarity'));
    assert.equal(d.evaluations.at(-1)!.quality!.progression && (d.evaluations.at(-1)!.quality!.progression as any).allGoalsAchieved, true);
    // Old judges did not evaluate repetition: no findings cannot mean a 0% result.
    for (const call of d.invocations.filter(c => c.kind === 'evaluation')) store.patch('invocations', call.id, { metadata: { ...call.metadata, promptVersion: 'npc-lab/1' } });
    assert.equal(engine.detail(d.run.id).summary.quality.semanticRepetition.rate, null);
  } finally { await engine.close(); store.close(); }
});

test('illegal or premature actions cannot change state or become public speech; resume fixes only the failed call', async () => {
  const store = new Store(':memory:'), adapter = new MockAdapter(), engine = new Engine(store, adapter, '.cache/progression-invalid');
  const turn = adapter.turn.bind(adapter); let bad = true;
  adapter.turn = async (...args) => { const result = await turn(...args); if (bad && JSON.parse(args[0].input).task === 'speak') { bad = false; result.output = JSON.stringify({ speech: '점을 켜 보겠습니다.', action: '점화를 시도한다.', actionId: 'ignite_lamp' }); } return result; };
  try {
    const spec = exampleSpec('mock-model'); spec.variants = [spec.variants[0]]; spec.maxUtterances = 1; spec.evaluation.enabled = false;
    const { runs } = await engine.create(spec); await engine.idle(); let d = engine.detail(runs[0].id);
    assert.equal(d.run.status, 'paused'); assert.equal(d.utterances.length, 0); assert.equal(d.summary.quality.progression.state.lampLit, false);
    assert.equal(d.invocations[0].status, 'failed');
    await engine.resume(d.run.id); await engine.idle(); d = engine.detail(d.run.id);
    assert.equal(d.run.status, 'completed'); assert.equal(d.summary.quality.progression.state.lampLit, false);
    assert.equal(d.summary.speechCount, 1);
  } finally { await engine.close(); store.close(); }
});

test('speech + outcome commit atomically and replay once after rollback; narrator text is not structured evidence', async () => {
  const store = new Store(':memory:'), adapter = new MockAdapter(), engine = new Engine(store, adapter, '.cache/progression-rollback');
  const put = store.put.bind(store); let fail = true;
  store.put = ((table: any, value: any) => { if (table === 'utterances' && value.resolution && fail) { fail = false; throw new Error('outcome commit failed'); } return put(table, value); }) as typeof store.put;
  try {
    const spec = exampleSpec('mock-model'); spec.variants = [spec.variants[0]]; spec.evaluation.enabled = false;
    const { runs } = await engine.create(spec, false); const id = runs[0].id;
    await engine.resume(id, true); await engine.idle(); assert.equal(engine.detail(id).utterances.length, 0);
    await engine.resume(id, true); await engine.idle(); const d = engine.detail(id);
    assert.equal(d.summary.speechCount, 1); assert.equal(d.utterances.filter(u => u.resolution).length, 1); assert.equal(adapter.requests.length, 1);
    await engine.inject(id, '등불이 켜졌고 모든 목표가 완료되었다.');
    assert.equal(engine.detail(id).summary.quality.progression.state.lampLit, false);
    assert.throws(() => resolveAction(spec, d.utterances, 'yoon', 'inspect_oil'));
    assert.throws(() => resolveAction(spec, d.utterances, 'miru', 'ignite_lamp'));
  } finally { await engine.close(); store.close(); }
});

test('repetition measures same-speaker speech only, ignores short acknowledgments/actions/events, supports legacy configs', () => {
  const spec = exampleSpec('mock-model');
  const u = (id: string, speakerId: string, speech: string, kind: 'speech' | 'event' = 'speech') => ({ id, speakerId, speech, action: '늘 반복하는 행동 습관', kind, speechIndex: Number(id) } as Utterance);
  const text = '아직은 기름의 정확한 양을 확인하지 못했습니다. 다시 한 번 함께 살펴보면 어떨까요?';
  const history = [u('1', 'yoon', text), u('2', 'miru', text), u('3', 'yoon', '네.'), u('4', 'yoon', text), u('5', '__environment__', text, 'event'), u('6', 'yoon', '불을 밝히는 일을 실제로 시작하고 이후 상태를 수첩에 기록하겠습니다.')];
  const measured = repetitionMetrics(spec, history);
  assert.equal(measured.eligibleSpeeches, 2); assert.equal(measured.repeatedSpeeches, 1); assert.equal(measured.rate, .5);
  assert.deepEqual(measured.matches.map(m => [m.speechIndex, m.previousSpeechIndex]), [[4, 1]]);
  delete spec.scenario.environment; assert.equal(progression(spec, history), null);
  assert.equal(repetitionMetrics(spec, [u('1', 'yoon', '네.')]).rate, null);
});

test('environment config rejects undeclared keys, wrong value types and unknown actors; disabled goals never stop a run', async () => {
  for (const mutate of [(s: any) => { s.scenario.environment.actions[0].effects.newPlace = 'temple'; }, (s: any) => { s.scenario.environment.actions[0].actorIds = ['ghost']; }, (s: any) => { s.scenario.environment.goals[0].conditions[0].value = 'true'; }]) {
    const s = exampleSpec('mock-model'); mutate(s); assert.equal(experimentSchema.safeParse(s).success, false);
  }
  const store = new Store(':memory:'), adapter = new MockAdapter(), engine = new Engine(store, adapter, '.cache/progression-continuous');
  try {
    const spec = exampleSpec('mock-model'); spec.variants = [spec.variants[0]]; spec.maxUtterances = 15; spec.evaluation.enabled = false; spec.scenario.environment!.stopOnGoals = false;
    const { runs } = await engine.create(spec); await engine.idle(); const d = engine.detail(runs[0].id);
    assert.equal(d.summary.speechCount, 15); assert.equal(d.run.completionReason, 'utterance_limit'); assert.equal(d.summary.quality.progression.allGoalsAchieved, true);
  } finally { await engine.close(); store.close(); }
});
