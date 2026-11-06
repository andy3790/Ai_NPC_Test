import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Engine } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
import { MockAdapter } from '../src/adapters/mock.js';
import { exampleSpec } from '../src/shared/example.js';
import { receiverPrompt, RECEIVE_BATCH_INSTRUCTION } from '../src/core/prompts.js';
import { receiveBarriers } from '../src/core/receive-delivery.js';
import { sourceUtteranceIds } from '../src/core/invocation-links.js';
import { exportFiles } from '../src/core/export.js';

test('receive prompt version 2 is frozen independently of NPC dialogue prompts', () => {
  assert.equal(createHash('sha256').update(RECEIVE_BATCH_INSTRUCTION).digest('hex'), '6ca403a5b8c905ed9790b5504a41cb62118ba9273547c7394bab50ade03ca765');
});

function setup(count = 1) {
  const store = new Store(':memory:'), adapter = new MockAdapter(); adapter.delayMs = 1;
  const engine = new Engine(store, adapter, '.cache/history-test-receive-delivery');
  const spec = exampleSpec('mock-model'); spec.maxUtterances = count; spec.evaluation.enabled = false;
  spec.variants = [{ ...spec.variants[1], deliveryMode: 'per_utterance' }];
  return { store, adapter, engine, spec };
}

test('bundled receipts deliver every observation once, preserve order, and export shared attribution', async () => {
  const { store, adapter, engine, spec } = setup(18);
  try {
    const { runs: [run] } = await engine.create(spec); await engine.idle(); const d = engine.detail(run.id);
    assert.equal(d.run.completionReason, 'goals_achieved'); assert.equal(d.summary.byKind.receive.calls, 32);
    assert.equal(d.receipts.length, 48); assert.equal(d.summary.pendingReceipts, 0);
    for (const character of spec.scenario.characters) {
      const actual = d.invocations.filter(c => c.kind === 'receive' && c.characterId === character.id).flatMap(c => {
        const input = JSON.parse(c.input), messages = input.messages ?? [input.message];
        assert.deepEqual(messages.map((u: any) => u.id), sourceUtteranceIds(c));
        if (messages.length === 2) {
          assert.equal(messages[1].resolution.sourceUtteranceId, messages[0].id);
          assert.equal(c.metadata.receivePromptVersion, 'npc-receive/2');
        }
        assert.ok(messages.every((u: any) => u.speakerId !== character.id));
        return messages.map((u: any) => u.id);
      });
      const expected = d.utterances.filter(u => d.receipts.some(r => r.characterId === character.id && r.utteranceId === u.id)).map(u => u.id);
      assert.deepEqual(actual, expected); assert.equal(new Set(actual).size, actual.length);
    }
    assert.ok(d.utterances.every(u => u.deliveryCompletedAt));
    const files = exportFiles(d, store.events(run.id));
    for (const call of d.invocations.filter(c => c.kind === 'receive' && sourceUtteranceIds(c).length === 2)) {
      assert.equal(d.receipts.filter(r => r.invocationId === call.id).length, 2);
      assert.equal(files['invocation-links.csv'].split('\n').filter(line => line.includes(call.id)).length, 2);
    }
    assert.ok(files['utterances.csv'].includes('receiveInvocationIds'));
  } finally { await engine.close(); store.close(); }
});

test('a failed bundle retries only its unfinished recipient without appending observations again', async () => {
  const { store, adapter, engine, spec } = setup();
  try {
    adapter.failNextKind = 'receive'; const { runs: [run] } = await engine.create(spec); await engine.idle();
    let d = engine.detail(run.id); assert.equal(d.run.status, 'paused');
    const failed = d.invocations.find(c => c.status === 'failed')!;
    assert.equal((failed.metadata.receiptIds as string[]).length, 2);
    assert.equal(d.receipts.filter(r => r.status === 'delivered').length, 3);
    await engine.resume(run.id); await engine.idle(); d = engine.detail(run.id);
    assert.equal(d.run.status, 'completed'); assert.equal(d.summary.byKind.receive.calls, 4);
    const retries = d.invocations.filter(c => c.retryOf); assert.equal(retries.length, 1);
    assert.equal(retries[0].retryOf, failed.id);
    const input = JSON.parse(retries[0].input); assert.ok(input.previousFailure); assert.ok(!input.messages && !input.message);
    assert.equal(d.receipts.filter(r => r.status === 'delivered').length, 5);
  } finally { await engine.close(); store.close(); }
});

test('receipt commit rollback reuses the accepted bundle and cannot commit only half its members', async () => {
  const { store, adapter, engine, spec } = setup();
  const put = store.put.bind(store); let written = 0;
  store.put = ((table: any, row: any) => {
    if (table === 'receipts' && row.characterId === 'doha' && row.status === 'delivered' && ++written === 2) throw new Error('receipt commit interrupted');
    return put(table, row);
  }) as typeof store.put;
  try {
    const { runs: [run] } = await engine.create(spec); await engine.idle(); let d = engine.detail(run.id);
    assert.equal(d.run.status, 'paused');
    assert.ok(d.receipts.filter(r => r.characterId === 'doha').every(r => r.status === 'processing'));
    const requestCount = adapter.requests.length;
    await engine.resume(run.id); await engine.idle(); d = engine.detail(run.id);
    assert.equal(d.run.status, 'completed'); assert.equal(adapter.requests.length, requestCount);
    assert.equal(d.receipts.filter(r => r.status === 'delivered').length, 5);
    assert.ok(d.utterances.every(u => u.deliveryCompletedAt));
  } finally { await engine.close(); store.close(); }
});

test('legacy accepted single-message calls retain their membership and do not swallow the outcome', async () => {
  const { store, adapter, engine, spec } = setup();
  try {
    const { runs: [run] } = await engine.create(spec); await engine.idle(); const original = engine.detail(run.id);
    const call = original.invocations.find(c => c.kind === 'receive' && c.characterId === 'doha')!;
    const [speech, outcome] = original.utterances;
    const receipts = original.receipts.filter(r => r.characterId === 'doha');
    // Seed the state of an older release after its single-message API call
    // succeeded but before the receipt write committed.
    store.patch('invocations', call.id, { input: receiverPrompt(speech, 'doha'), metadata: { receiptIds: [receipts[0].id] } });
    for (const receipt of receipts) store.patch('receipts', receipt.id, { status: 'pending', invocationId: null, deliveredAt: null });
    store.patch('runs', run.id, { status: 'paused', completedAt: null });
    const before = adapter.requests.length;
    await engine.resume(run.id); await engine.idle(); const d = engine.detail(run.id);
    assert.equal(d.run.status, 'completed'); assert.equal(adapter.requests.length, before + 1);
    assert.equal(JSON.parse(adapter.requests.at(-1)!.input).message.id, outcome.id);
    assert.equal(d.receipts.find(r => r.id === receipts[0].id)!.invocationId, call.id);
    assert.notEqual(d.receipts.find(r => r.id === receipts[1].id)!.invocationId, call.id);
  } finally { await engine.close(); store.close(); }
});

test('ambiguous bundled calls cannot be repackaged and resent on resume', async () => {
  const { store, adapter, engine, spec } = setup();
  const turn = adapter.turn.bind(adapter); let fail = true;
  adapter.turn = async (...args) => {
    const result = await turn(...args);
    if (fail && JSON.parse(args[0].input).messages) {
      fail = false; adapter.results.delete(result.turnId);
      return { ...result, status: 'uncertain', error: 'unknown outcome', inputRetained: false };
    }
    return result;
  };
  try {
    const { runs: [run] } = await engine.create(spec); await engine.idle();
    assert.equal(engine.detail(run.id).run.status, 'paused'); const before = adapter.requests.length;
    await assert.rejects(engine.resume(run.id), /미확정|확인/);
    assert.equal(adapter.requests.length, before);
  } finally { await engine.close(); store.close(); }
});

test('unrelated events keep separate barriers and incomplete legacy timestamps recover without a call', async () => {
  const { store, adapter, engine, spec } = setup();
  try {
    const { runs: [run] } = await engine.create(spec); await engine.idle(); let d = engine.detail(run.id);
    const history = structuredClone(d.utterances), pending = d.receipts.map(r => ({ ...r, status: 'pending' as const }));
    delete history[1].resolution;
    const barriers = receiveBarriers(history, pending, []); assert.equal(barriers.length, 2);
    assert.ok(barriers.flatMap(b => b.recipients.flat()).every(b => b.messages.length === 1));
    const before = adapter.requests.length;
    store.patch('utterances', d.utterances[0].id, { deliveryCompletedAt: null, deliveryMs: null });
    store.patch('runs', run.id, { status: 'paused', completedAt: null });
    await engine.resume(run.id); await engine.idle(); d = engine.detail(run.id);
    assert.equal(adapter.requests.length, before); assert.ok(d.utterances[0].deliveryCompletedAt);
  } finally { await engine.close(); store.close(); }
});
