import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
import { MockAdapter } from '../src/adapters/mock.js';
import type { AdapterEvent, TurnRequest } from '../src/adapters/types.js';
import { exampleSpec } from '../src/shared/example.js';

class ControlledAdapter extends MockAdapter {
  hold = true;
  active = 0;
  maximum = 0;
  pending: { request: TurnRequest; release: () => void }[] = [];
  override async turn(request: TurnRequest, emit: (event: AdapterEvent) => void, signal?: AbortSignal) {
    this.active++;
    this.maximum = Math.max(this.maximum, this.active);
    try {
      if (this.hold) await new Promise<void>(resolve => {
        const entry = { request, release: () => { this.pending = this.pending.filter(item => item !== entry); resolve(); } };
        this.pending.push(entry);
      });
      return await super.turn(request, emit, signal);
    } finally { this.active--; }
  }
  releaseAll() { this.hold = false; for (const entry of [...this.pending]) entry.release(); }
}

function spec(limit = 1) {
  const value = exampleSpec('mock-model');
  delete value.scenario.environment;
  value.variants = [{ ...value.variants[0], deliveryMode: 'per_utterance' }];
  value.maxConcurrentCalls = limit;
  value.maxUtterances = 2;
  value.evaluation.enabled = false;
  return value;
}

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'The expected scheduler state was not reached.');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

function setup() {
  const store = new Store(':memory:');
  const adapter = new ControlledAdapter(); adapter.delayMs = 0;
  const engine = new Engine(store, adapter, '.cache/engine-controls-unused');
  return { store, adapter, engine };
}

test('manual event delivery obeys the call limit before a run has ever started', async () => {
  const { store, adapter, engine } = setup();
  let delivery: Promise<void> | undefined;
  try {
    const { runs } = await engine.create(spec(1), false);
    delivery = engine.inject(runs[0].id, '새로운 상황');
    await until(() => store.list('invocations', runs[0].id).length === 3 && adapter.pending.length === 1);
    assert.equal(adapter.active, 1);
    assert.equal(store.list('invocations', runs[0].id).filter(call => call.status === 'queued').length, 2);
    adapter.releaseAll(); await delivery;
    assert.equal(adapter.maximum, 1);
    assert.equal(engine.detail(runs[0].id).summary.pendingReceipts, 0);
  } finally { adapter.releaseAll(); await delivery?.catch(() => {}); await engine.close(); store.close(); }
});

test('finishing an automatic worker raises the shared limit and wakes queued manual calls', async () => {
  const { store, adapter, engine } = setup();
  let delivery: Promise<void> | undefined;
  try {
    const automaticSpec = spec(1);
    automaticSpec.maxUtterances = 1; automaticSpec.variants[0].deliveryMode = 'batched_on_turn';
    const automatic = (await engine.create(automaticSpec)).runs[0];
    await until(() => adapter.pending.length === 1);
    const manual = (await engine.create(spec(3), false)).runs[0];
    delivery = engine.inject(manual.id, '세 명에게 전달할 상황');
    await until(() => store.list('invocations', manual.id).length === 3);
    assert.equal(adapter.active, 1);
    assert.ok(store.list('invocations', manual.id).every(call => call.status === 'queued'));
    adapter.pending[0].release();
    await until(() => engine.run(automatic.id).status === 'completed' && adapter.pending.length === 3);
    assert.equal(adapter.active, 3);
    assert.equal(store.list('invocations', manual.id).filter(call => call.status === 'running').length, 3);
    adapter.releaseAll(); await delivery; await engine.idle();
    assert.equal(engine.detail(manual.id).summary.pendingReceipts, 0);
  } finally { adapter.releaseAll(); await delivery?.catch(() => {}); await engine.close(); store.close(); }
});

test('manual evaluation participates in the shared call limit with automatic runs', async () => {
  const { store, adapter, engine } = setup();
  let evaluation: Promise<void> | undefined;
  try {
    adapter.hold = false;
    const judgedSpec = spec(1); judgedSpec.evaluation.enabled = true; judgedSpec.evaluation.interval = 10;
    const judged = (await engine.create(judgedSpec, false)).runs[0];
    await engine.resume(judged.id, true); await engine.idle();
    assert.equal(engine.run(judged.id).status, 'paused');
    adapter.hold = true; adapter.maximum = 0;
    evaluation = engine.evaluate(judged.id);
    await until(() => adapter.pending.length === 1);
    assert.equal(JSON.parse(adapter.pending[0].request.input).task, 'evaluate');
    const automatic = (await engine.create(spec(3))).runs[0];
    await until(() => store.list('invocations', automatic.id).some(call => call.status === 'queued'));
    assert.equal(adapter.active, 1);
    adapter.pending[0].release(); await evaluation;
    await until(() => adapter.pending.length === 1);
    adapter.pending[0].release();
    await until(() => adapter.pending.length === 2);
    assert.equal(adapter.active, 2);
    adapter.releaseAll(); await engine.idle();
    assert.equal(engine.detail(judged.id).evaluations[0].status, 'completed');
    assert.equal(engine.run(automatic.id).status, 'completed');
  } finally { adapter.releaseAll(); await evaluation?.catch(() => {}); await engine.close(); store.close(); }
});

test('prototype-named character IDs own independent sessions across pause and resume', async () => {
  const store = new Store(':memory:');
  const adapter = new MockAdapter(); adapter.delayMs = 0;
  const engine = new Engine(store, adapter, '.cache/engine-controls-unused');
  try {
    const input = spec(2); input.maxUtterances = 6;
    const ids = ['__proto__', 'constructor', 'toString'];
    input.scenario.characters.forEach((character, index) => { character.id = ids[index]; });
    adapter.resumeSession = async threadId => { assert.equal(typeof threadId, 'string'); assert.ok(adapter.instructions.has(threadId)); };
    const run = (await engine.create(input, false)).runs[0];
    await engine.resume(run.id, true); await engine.idle();
    const before = engine.detail(run.id);
    assert.equal(before.run.status, 'paused', before.run.error ?? '');
    for (const id of ids) {
      assert.ok(Object.hasOwn(before.run.sessions, id));
      assert.equal(before.run.sessions[id].characterId, id);
    }
    await engine.resume(run.id); await engine.idle();
    const after = engine.detail(run.id);
    assert.equal(after.run.status, 'completed', after.run.error ?? '');
    assert.deepEqual(after.utterances.map(utterance => utterance.speakerId), [...ids, ...ids]);
    assert.equal(new Set(adapter.requests.map(request => request.threadId)).size, 3);
    assert.equal(after.summary.pendingReceipts, 0);
    for (const id of ids) assert.equal(after.run.sessions[id].threadId, before.run.sessions[id].threadId);
  } finally { await engine.close(); store.close(); }
});
