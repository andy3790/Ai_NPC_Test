import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/core/store.js';
import { Engine } from '../src/core/engine.js';
import { MockAdapter } from '../src/adapters/mock.js';
import { exampleSpec } from '../src/shared/example.js';
import { evaluationPrompt, publicMessage } from '../src/core/prompts.js';
import type { Utterance } from '../src/shared/types.js';

function transcript(runId: string): Utterance[] {
  return Array.from({ length: 3 }, (_, index) => {
    const speechIndex = index + 1;
    const speech: Utterance = {
      id: `${runId}-speech-${speechIndex}`, runId, sequence: index * 2 + 1, speechIndex,
      speakerId: 'yoon', speakerName: '윤', kind: 'speech', speech: '가'.repeat(260), action: '',
      createdAt: new Date().toISOString(), invocationId: null, deliveryCompletedAt: null, deliveryMs: null,
    };
    const event: Utterance = {
      ...speech, id: `${runId}-event-${speechIndex}`, sequence: index * 2 + 2, speechIndex: null,
      speakerId: '__environment__', speakerName: '환경 결과', kind: 'event', speech: '나'.repeat(260),
      resolution: { actionId: `action-${speechIndex}`, sourceUtteranceId: speech.id, speechIndex,
        actorId: 'yoon', before: { checked: index }, after: { checked: speechIndex } },
    };
    return [speech, event];
  }).flat();
}

test('evaluation trimming keeps every target and its environment outcome', () => {
  const spec = exampleSpec('mock-model'); spec.evaluation.contextCharacters = 1000;
  const history = transcript('test');
  const older = { ...history[0], id: 'older', sequence: 0, speech: 'old'.repeat(500) };
  const targets = history.filter(u => u.kind === 'speech');
  const result = evaluationPrompt(spec, [older, ...history], targets);
  const input = JSON.parse(result.input);
  assert.equal(result.truncated, true);
  assert.equal(result.overBudget, true);
  assert.deepEqual(input.history.map((u: Utterance) => u.id), history.map(u => u.id));
  assert.ok(input.targetIds.every((id: string) => input.history.some((u: Utterance) => u.id === id)));
});

test('large evaluation ranges split without losing targets, outcomes, coverage or retry history', async () => {
  const store = new Store(':memory:'), adapter = new MockAdapter(); adapter.delayMs = 0;
  const engine = new Engine(store, adapter, '.cache/evaluation-context');
  try {
    const spec = exampleSpec('mock-model'); delete spec.scenario.environment;
    spec.variants = [spec.variants[0]]; spec.evaluation.interval = 3;
    const sample = transcript('sample');
    spec.evaluation.contextCharacters = Math.max(1000, JSON.stringify(sample.slice(0, 2).map(publicMessage)).length + 150);
    const { runs } = await engine.create(spec, false); const id = runs[0].id;
    const history = transcript(id);
    for (const u of history) store.put('utterances', u);
    // A previous failed checkpoint must be replaced by durable child ranges,
    // while retaining its original failure for exported audit history.
    const previous = { id: `${id}:eval:1:3`, runId: id, from: 1, to: 3, status: 'failed' as const,
      contextTruncated: true, summary: '', invocationId: null, error: 'previous transport failure' };
    store.put('evaluations', previous); store.patch('runs', id, { evaluatedThrough: 3 });
    await engine.evaluate(id);
    const detail = engine.detail(id);
    assert.deepEqual(detail.evaluations.map(e => [e.from, e.to, e.status]), [[1, 1, 'completed'], [2, 2, 'completed'], [3, 3, 'completed']]);
    assert.equal(detail.summary.evaluatedUtterances, 3);
    assert.equal(detail.summary.evaluationFailures, 0);
    assert.equal(detail.invocations.length, 3);
    const evaluated: string[] = [];
    for (const call of detail.invocations) {
      const input = JSON.parse(call.input);
      assert.ok(JSON.stringify(input.history).length <= spec.evaluation.contextCharacters);
      for (const target of input.targetIds) {
        evaluated.push(target);
        assert.ok(input.history.some((u: Utterance) => u.id === target));
        assert.ok(input.history.some((u: Utterance) => u.resolution?.sourceUtteranceId === target));
      }
      const lastTargetSequence = Math.max(...history.filter(u => input.targetIds.includes(u.id)).map(u => u.sequence));
      assert.ok(input.history.every((u: Utterance) => u.sequence <= lastTargetSequence + 1));
    }
    assert.deepEqual(evaluated, history.filter(u => u.kind === 'speech').map(u => u.id));
    const split = store.events(id).find(e => e.method === 'evaluation/range_split');
    assert.deepEqual((split?.params as { previous: unknown }).previous, previous);
    await engine.evaluate(id);
    assert.equal(engine.detail(id).invocations.length, 3, 'retry must not repeat completed child calls');
  } finally { await engine.close(); store.close(); }
});

test('one oversized target is explicitly unevaluated, while other split ranges can complete', async () => {
  const store = new Store(':memory:'), adapter = new MockAdapter(); adapter.delayMs = 0;
  const engine = new Engine(store, adapter, '.cache/evaluation-oversized');
  try {
    const spec = exampleSpec('mock-model'); delete spec.scenario.environment;
    spec.variants = [spec.variants[0]]; spec.evaluation.interval = 3;
    spec.evaluation.contextCharacters = 1500;
    const { runs } = await engine.create(spec, false); const id = runs[0].id;
    const history = transcript(id); history[0].speech = '긴 발화'.repeat(1000);
    for (const u of history) store.put('utterances', u);
    await engine.evaluate(id);
    const detail = engine.detail(id);
    const failed = detail.evaluations.filter(e => e.status === 'failed');
    assert.equal(failed.length, 1);
    assert.deepEqual([failed[0].from, failed[0].to], [1, 1]);
    assert.match(failed[0].error!, /미평가/);
    assert.equal(failed[0].invocationId, null);
    assert.equal(detail.summary.evaluatedUtterances, 2);
    assert.equal(detail.summary.evaluationFailures, 1);
    assert.equal(detail.invocations.length, 2);
    assert.ok(detail.invocations.every(c => !JSON.parse(c.input).targetIds.includes(history[0].id)));
  } finally { await engine.close(); store.close(); }
});

for (const evaluatedThrough of [0, 3]) test(`recovered parent and child failures are attempted once per manual evaluation (checkpoint ${evaluatedThrough})`, async () => {
  const store = new Store(':memory:'), adapter = new MockAdapter();
  const engine = new Engine(store, adapter, '.cache/evaluation-recovered-split');
  adapter.turn = async (request, emit) => {
    const turnId = request.clientMessageId;
    emit({ method: 'turn/accepted', params: { turnId, threadId: request.threadId } });
    return { turnId, output: '', status: 'failed', error: 'persistent judge failure', inputRetained: false };
  };
  try {
    const spec = exampleSpec('mock-model'); delete spec.scenario.environment;
    spec.variants = [spec.variants[0]]; spec.evaluation.interval = 3;
    const sample = transcript('sample');
    spec.evaluation.contextCharacters = Math.max(1000, JSON.stringify(sample.slice(0, 2).map(publicMessage)).length + 150);
    const id = (await engine.create(spec, false)).runs[0].id;
    for (const utterance of transcript(id)) store.put('utterances', utterance);
    // A crash during an earlier split can leave the failed parent together with
    // its first failed child, before or after the checkpoint cursor is advanced.
    for (const [from, to] of [[1, 3], [1, 1]]) store.put('evaluations', {
      id: `${id}:eval:${from}:${to}`, runId: id, from, to, status: 'failed',
      contextTruncated: true, summary: '', invocationId: null, error: 'failure before restart',
    });
    store.patch('runs', id, { evaluatedThrough });
    await engine.evaluate(id);
    let calls = store.list('invocations', id);
    assert.deepEqual(calls.map(call => [call.operationKey, call.attempt]), [
      ['eval:1:1', 1], ['eval:2:2', 1], ['eval:3:3', 1],
    ]);
    assert.equal(engine.detail(id).summary.evaluationFailures, 3);
    await engine.evaluate(id);
    calls = store.list('invocations', id);
    assert.equal(calls.length, 6, 'a new manual request may retry each failed child once');
    assert.ok(calls.slice(3).every(call => call.attempt === 2));
  } finally { await engine.close(); store.close(); }
});

for (const status of ['uncertain', 'running'] as const) for (const hasFailure of [true, false]) {
  test(`splitting cannot bypass a ${status} parent invocation (failure record ${hasFailure})`, async () => {
    const store = new Store(':memory:'), adapter = new MockAdapter(); adapter.delayMs = 0;
    const engine = new Engine(store, adapter, '.cache/evaluation-unresolved-parent');
    try {
      const spec = exampleSpec('mock-model'); delete spec.scenario.environment;
      spec.variants = [spec.variants[0]]; spec.evaluation.interval = 3;
      const id = (await engine.create(spec, false)).runs[0].id;
      for (const utterance of transcript(id)) store.put('utterances', utterance);
      await engine.evaluate(id);
      const initial = engine.detail(id);
      assert.equal(initial.invocations.length, 1);
      const parent = initial.invocations[0], checkpoint = initial.evaluations[0];
      // Model an older checkpoint interrupted before its outcome was known.
      // The smaller history budget now requires child ranges under the new
      // target-preserving evaluation prompt.
      store.patch('invocations', parent.id, { status, error: 'outcome unknown' });
      if (hasFailure) store.patch('evaluations', checkpoint.id, { status: 'failed', error: 'interrupted evaluation' });
      else store.remove('evaluations', checkpoint.id);
      const restoredSpec = structuredClone(initial.run.spec);
      const sample = transcript('sample');
      restoredSpec.evaluation.contextCharacters = Math.max(1000, JSON.stringify(sample.slice(0, 2).map(publicMessage)).length + 150);
      store.patch('runs', id, { spec: restoredSpec, evaluatedThrough: hasFailure ? 3 : 0 });
      await engine.evaluate(id);
      await engine.evaluate(id);
      const blocked = engine.detail(id);
      assert.equal(adapter.requests.length, 1, 'uncertain parent must block every child model request');
      assert.equal(blocked.invocations.length, 1);
      assert.equal(blocked.invocations[0].status, status, 'the guard must not resolve or fail the original call');
      assert.equal(blocked.evaluations.length, 1);
      assert.deepEqual([blocked.evaluations[0].from, blocked.evaluations[0].to, blocked.evaluations[0].status], [1, 3, 'failed']);
      assert.equal(blocked.evaluations[0].invocationId, parent.id);
      assert.match(blocked.evaluations[0].error!, /미확정 호출/);
      assert.equal(blocked.summary.evaluatedUtterances, 0);
      assert.ok(!store.events(id).some(event => event.method === 'evaluation/range_split'));
      // Once reconciliation establishes failure, normal splitting may proceed.
      store.patch('invocations', parent.id, { status: 'failed', error: 'failure confirmed' });
      await engine.evaluate(id);
      assert.equal(adapter.requests.length, 4);
      assert.equal(engine.detail(id).summary.evaluatedUtterances, 3);
    } finally { await engine.close(); store.close(); }
  });
}
