import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockAdapter } from '../src/adapters/mock.js';
import type { AdapterEvent, TurnRequest } from '../src/adapters/types.js';
import { Engine } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
import { exampleSpec } from '../src/shared/example.js';
import { dialogueIsIdle } from '../src/core/dialogue-idle.js';
import type { Run, Utterance } from '../src/shared/types.js';

class SilentAdapter extends MockAdapter {
  override async turn(request: TurnRequest, emit: (e: AdapterEvent) => void, signal?: AbortSignal) {
    const result = await super.turn(request, emit, signal);
    if (JSON.parse(request.input).task !== 'speak') return result;
    const silent = { ...result, output: '{"speech":"","action":""}' };
    this.results.set(result.turnId, silent);
    return silent;
  }
}

for (const deliveryMode of ['per_utterance', 'batched_on_turn'] as const) test(`${deliveryMode}: silence completes a full round without invented gestures or receiver calls`, async () => {
  const adapter = new SilentAdapter(), store = new Store(':memory:'), engine = new Engine(store, adapter, '.cache/silence-tests');
  const spec = exampleSpec('mock-model'); delete spec.scenario.environment;
  spec.maxUtterances = 12; spec.evaluation.enabled = false;
  spec.variants = [{ ...spec.variants[0], deliveryMode, stopOnSilence: true, environmentMode: 'off' }];
  try {
    const { runs } = await engine.create(spec); await engine.idle();
    const d = engine.detail(runs[0].id);
    assert.equal(d.run.status, 'completed'); assert.equal(d.run.completionReason, 'conversation_idle');
    assert.equal(d.utterances.length, spec.scenario.characters.length);
    assert.ok(d.utterances.every(u => !u.speech && !u.action && u.deliveryCompletedAt));
    assert.equal(d.receipts.length, 0);
    assert.ok(d.invocations.every(c => c.kind === 'speech' && c.status === 'completed'));
    assert.equal(d.summary.failed, 0);
  } finally { await engine.close(); store.close(); }
});

test('silence completion is opt-in and does not drop scheduled events', async () => {
  const adapter = new SilentAdapter(), store = new Store(':memory:'), engine = new Engine(store, adapter, '.cache/silence-tests');
  const spec = exampleSpec('mock-model'); delete spec.scenario.environment;
  spec.maxUtterances = 8; spec.evaluation.enabled = false;
  spec.variants = [{ ...spec.variants[0], id: 'until-limit', stopOnSilence: false }, { ...spec.variants[0], id: 'after-event', stopOnSilence: true }];
  spec.scheduledEvents = [{ afterUtterance: 4, text: '문에서 소리가 났다.' }];
  try {
    const { runs } = await engine.create(spec); await engine.idle();
    const limit = engine.detail(runs[0].id), idle = engine.detail(runs[1].id);
    assert.equal(limit.summary.speechCount, 8); assert.equal(limit.run.completionReason, 'utterance_limit');
    assert.equal(idle.run.completionReason, 'conversation_idle');
    assert.equal(idle.summary.speechCount, 7, 'All three actors get another turn after the event');
    assert.ok(idle.utterances.some(u => u.kind === 'event'));
    assert.equal(idle.receipts.length, 3, 'Only the actual event is delivered');
  } finally { await engine.close(); store.close(); }
});

test('silence detection needs every participant, resets on new observations/actions, and never ends world simulation', () => {
  const spec = exampleSpec('mock-model'); delete spec.scenario.environment;
  const run = { spec, variant: { ...spec.variants[0], environmentMode: 'off', stopOnSilence: true }, appliedEvents: [] } as unknown as Run;
  const silence = (speakerId: string) => ({ kind: 'speech', speakerId, speech: '', action: '' } as Utterance);
  const all = spec.scenario.characters.map(c => silence(c.id));
  assert.equal(dialogueIsIdle(run, all), true);
  assert.equal(dialogueIsIdle(run, [all[0], all[0], all[1]]), false);
  assert.equal(dialogueIsIdle(run, [...all.slice(0, 2), { ...all[2], action: '문을 두드린다.' }]), false);
  assert.equal(dialogueIsIdle(run, [...all, { ...all[0], kind: 'event' }]), false);
  assert.equal(dialogueIsIdle({ ...run, variant: { ...run.variant, environmentMode: 'ai' } }, all), false);
  assert.equal(dialogueIsIdle({ ...run, variant: { ...run.variant, environmentMode: 'ai_spatial' } }, all), false);
});
