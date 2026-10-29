import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/core/store.js';
import { Engine } from '../src/core/engine.js';
import { MockAdapter } from '../src/adapters/mock.js';
import { exampleSpec } from '../src/shared/example.js';
import { aggregate, UsageTracker } from '../src/core/metrics.js';
import { exportFiles, zipFiles } from '../src/core/export.js';
import { createApp } from '../src/server/app.js';
function setup(mode: 'batched_on_turn' | 'per_utterance', count = 6) {
  const store = new Store(':memory:'); const adapter = new MockAdapter(); const engine = new Engine(store, adapter, '.cache/test-runtime');
  const spec = exampleSpec('mock-model'); spec.maxUtterances = count; spec.evaluation.enabled = false;
  delete spec.scenario.environment; // Original delivery contract without environment events.
  spec.variants = [{ ...spec.variants[0], deliveryMode: mode }];
  return { store, adapter, engine, spec };
}
for (const mode of ['batched_on_turn', 'per_utterance'] as const) test(`${mode}: broadcast counts, ordering, isolation, exports`, async () => {
  const { engine, store, adapter, spec } = setup(mode); spec.repetitions = 2;
  try {
    const { runs } = await engine.create(spec); await engine.idle();
    for (const run of runs) {
      const d = engine.detail(run.id); assert.equal(d.run.status, 'completed'); assert.equal(d.utterances.length, 6);
      assert.equal(d.invocations.filter(c => c.kind === 'speech').length, 6);
      assert.equal(d.invocations.filter(c => c.kind === 'receive').length, mode === 'per_utterance' ? 12 : 0);
      assert.equal(d.summary.pendingReceipts, mode === 'per_utterance' ? 0 : 3);
      assert.deepEqual(d.utterances.map(u => u.speakerId), ['yoon', 'doha', 'miru', 'yoon', 'doha', 'miru']);
      const known = new Set(d.utterances.map(u => u.id));
      for (const c of d.invocations) {
        const input = JSON.parse(c.input);
        for (const m of input.messages ?? (input.message ? [input.message] : [])) { assert.ok(known.has(m.id)); assert.notEqual(m.speakerId, c.characterId); }
      }
      if (mode === 'per_utterance') for (let i = 1; i < d.utterances.length; i++) {
        const first = d.utterances[i - 1]; const next = d.invocations.find(c => c.utteranceId === d.utterances[i].id)!;
        const listeners = d.invocations.filter(c => c.sourceUtteranceId === first.id);
        assert.equal(listeners.length, 2); assert.ok(listeners.every(c => c.completedAt! <= next.startedAt!));
      }
      const files = exportFiles(d, store.events(run.id)); const jsonl = files['records.jsonl'].trim().split('\n').map(line => JSON.parse(line));
      const exported = jsonl.filter((x: any) => x.type === 'invocation');
      assert.equal(aggregate(exported).tokens.totalTokens, d.summary.tokens.totalTokens);
      assert.ok(files['invocations.csv'].includes('reasoningOutputTokens')); assert.equal(zipFiles(files).readUInt32LE(0), 0x04034b50);
    }
    assert.equal(new Set(adapter.requests.map(r => r.threadId)).size, 6);
  } finally { await engine.close(); store.close(); }
});
test('receiver failure pauses barrier; resume retries only incomplete receipt without duplicate payload', async () => {
  const { engine, store, adapter, spec } = setup('per_utterance', 3);
  try {
    adapter.failNextKind = 'receive'; const { runs } = await engine.create(spec); await engine.idle();
    const id = runs[0].id; let d = engine.detail(id); assert.equal(d.run.status, 'paused'); assert.equal(d.utterances.length, 1);
    assert.equal(d.receipts.filter(r => r.status === 'delivered').length, 1);
    await engine.resume(id); await engine.idle(); d = engine.detail(id);
    assert.equal(d.run.status, 'completed'); assert.equal(d.utterances.length, 3);
    assert.equal(d.invocations.filter(c => c.kind === 'receive').length, 7);
    const retry = d.invocations.find(c => c.retryOf)!; assert.ok(!JSON.parse(retry.input).message); assert.ok(retry.turnId);
  } finally { await engine.close(); store.close(); }
});
test('step includes receipt barrier, manual event is delivered to all; reinjection only for speech', async () => {
  const { engine, store, spec } = setup('per_utterance', 3); spec.variants[0].memoryMode = 'reinject_on_speech';
  try {
    const { runs } = await engine.create(spec, false); const id = runs[0].id; await engine.resume(id, true); await engine.idle();
    let d = engine.detail(id); assert.equal(d.run.status, 'paused'); assert.equal(d.utterances.length, 1); assert.equal(d.summary.pendingReceipts, 0);
    await engine.inject(id, '바람이 잦아들었다.'); d = engine.detail(id);
    assert.equal(d.receipts.filter(r => r.utteranceId === d.utterances[1].id && r.status === 'delivered').length, 3);
    assert.ok(d.invocations.filter(c => c.kind === 'speech').every(c => JSON.parse(c.input).originalCharacterAndWorld));
    assert.ok(d.invocations.filter(c => c.kind === 'receive').every(c => !JSON.parse(c.input).originalCharacterAndWorld));
  } finally { await engine.close(); store.close(); }
});
test('director, evaluation checkpoints and human review stay out of public dialogue', async () => {
  const { engine, store, spec } = setup('batched_on_turn', 5); spec.variants[0].turnPolicy = 'director'; spec.evaluation.enabled = true; spec.evaluation.interval = 2;
  try {
    const { runs } = await engine.create(spec); await engine.idle(); const d = engine.detail(runs[0].id);
    assert.equal(d.run.status, 'completed'); assert.equal(d.invocations.filter(c => c.kind === 'director').length, 4);
    assert.deepEqual(d.evaluations.map(e => [e.from, e.to]), [[1, 2], [3, 4], [5, 5]]);
    assert.equal(d.summary.evaluatedUtterances, 5); assert.equal(d.utterances.length, 5);
    for (let i = 1; i < d.utterances.length; i++) assert.notEqual(d.utterances[i].speakerId, d.utterances[i - 1].speakerId);
  } finally { await engine.close(); store.close(); }
});
test('unknown outcomes block resend; completed but uncommitted call is recovered exactly once', async () => {
  const { engine, store, spec } = setup('batched_on_turn', 2);
  try {
    const { runs } = await engine.create(spec, false); const id = runs[0].id; await engine.resume(id, true); await engine.idle();
    const first = engine.detail(id).invocations[0]; store.patch('invocations', first.id, { status: 'uncertain' });
    await engine.resume(id); await engine.idle(); const d = engine.detail(id);
    assert.equal(d.utterances.length, 2); assert.equal(d.invocations.filter(c => c.kind === 'speech').length, 2);
  } finally { await engine.close(); store.close(); }
});
test('usage cumulative snapshots deduplicate; missing/discontinuous values are not zero', () => {
  const baseline = { inputTokens: 10, cachedInputTokens: 5, cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 2, totalTokens: 20 };
  const tracker = new UsageTracker(baseline); const total = { ...baseline, inputTokens: 30, cachedInputTokens: 15, outputTokens: 20, reasoningOutputTokens: 5, totalTokens: 50 };
  tracker.update({ tokenUsage: { total } }); tracker.update({ tokenUsage: { total } }); assert.equal(tracker.result().usage.totalTokens, 30); assert.equal(tracker.result().usage.reasoningOutputTokens, 3);
  tracker.update({ tokenUsage: { total: baseline } }); assert.equal(tracker.result().usage.totalTokens, null);
  assert.equal(new UsageTracker(baseline).result().usage.totalTokens, null);
  const unknown = new UsageTracker(null); unknown.update({ tokenUsage: { total } }); assert.equal(unknown.result().status, 'unknown_baseline');
});
test('completed generation before transaction failure is reused, never generated twice', async () => {
  const { engine, store, adapter, spec } = setup('batched_on_turn', 2);
  const put = store.put.bind(store); let fail = true;
  store.put = ((table: any, value: any) => { if (table === 'utterances' && fail) { fail = false; throw new Error('모의 커밋 실패'); } return put(table, value); }) as typeof store.put;
  try {
    const { runs } = await engine.create(spec); await engine.idle(); const id = runs[0].id;
    assert.equal(engine.detail(id).run.status, 'paused'); assert.equal(engine.detail(id).utterances.length, 0);
    await engine.resume(id); await engine.idle();
    assert.equal(engine.detail(id).utterances.length, 2); assert.equal(adapter.requests.length, 2);
  } finally { await engine.close(); store.close(); }
});
test('scheduled events, model precedence, recipient privacy, and shared concurrency cap', async () => {
  const { engine, store, adapter, spec } = setup('per_utterance', 3);
  spec.repetitions = 2; spec.maxConcurrentCalls = 1;
  spec.scenario.characters[0].effort = 'high'; spec.variants[0].effort = 'medium';
  spec.scheduledEvents = [{ afterUtterance: 1, text: '안개가 조금 옅어졌다.' }];
  let concurrent = 0, maximum = 0; const turn = adapter.turn.bind(adapter);
  adapter.turn = async (...args) => { concurrent++; maximum = Math.max(maximum, concurrent); try { return await turn(...args); } finally { concurrent--; } };
  try {
    const { runs } = await engine.create(spec); await engine.idle(); assert.equal(maximum, 1);
    for (const r of runs) {
      const d = engine.detail(r.id); assert.equal(d.utterances.filter(u => u.kind === 'event').length, 1);
      assert.equal(d.run.sessions.yoon.config.effort, 'high'); assert.equal(d.run.sessions.doha.config.effort, 'medium');
      assert.ok(!d.run.sessions.yoon.instructions.includes(spec.scenario.characters[1].memories));
      assert.equal(d.invocations.filter(c => c.kind === 'receive').length, 9);
    }
  } finally { await engine.close(); store.close(); }
});
test('evaluation findings reference actual evidence and support independent human review', async () => {
  const { engine, store, adapter, spec } = setup('batched_on_turn', 3); spec.evaluation.enabled = true; spec.evaluation.interval = 3;
  const turn = adapter.turn.bind(adapter); let n = 0;
  adapter.turn = async (...args) => { const result = await turn(...args); if (JSON.parse(args[0].input).task === 'speak') { const speech = ['내가 용을 소환했어.', '기름은 무한하다고 기억합니다.', '야 이 멍청아, 서둘러.'][n++]; result.output = JSON.stringify({ speech, action: '' }); } return result; };
  try {
    const { runs } = await engine.create(spec); await engine.idle(); let d = engine.detail(runs[0].id);
    assert.equal(d.findings.length, 3); assert.equal(d.summary.issueRate, 1);
    engine.review(d.findings[0].id, 'dismissed', '직접 검토 예제'); d = engine.detail(runs[0].id);
    assert.equal(d.findings[0].verdict, 'issue'); assert.equal(d.findings[0].review, 'dismissed'); assert.equal(d.summary.issueRate, 2 / 3);
  } finally { await engine.close(); store.close(); }
});
test('restart recreates only never-invoked missing threads; existing dialogue is never replaced', async () => {
  const { engine, store, adapter, spec } = setup('batched_on_turn', 3);
  try {
    const { runs } = await engine.create(spec, false); const id = runs[0].id;
    await engine.resume(id, true); await engine.idle(); const before = engine.detail(id);
    const missing = new Set(Object.values(before.run.sessions).filter(s => s.characterId !== 'yoon').map(s => s.threadId));
    adapter.resumeSession = async threadId => { if (missing.has(threadId)) throw new Error(`no rollout found for thread id ${threadId}`); };
    await engine.resume(id); await engine.idle(); const after = engine.detail(id);
    assert.equal(after.run.status, 'completed'); assert.equal(after.invocations.length, 3);
    assert.equal(after.run.sessions.yoon.threadId, before.run.sessions.yoon.threadId);
    assert.equal(after.run.sessions.doha.id, before.run.sessions.doha.id);
    assert.notEqual(after.run.sessions.doha.threadId, before.run.sessions.doha.threadId);
    assert.equal(store.events(id).filter(e => e.method === 'session/recreated_empty').length, 2);
    const second = await engine.create(spec, false); const sid = second.runs[0].id;
    await engine.resume(sid, true); await engine.idle(); const usedId = engine.detail(sid).run.sessions.yoon.threadId;
    missing.add(usedId); await engine.resume(sid); await engine.idle();
    assert.equal(engine.detail(sid).run.status, 'paused'); assert.equal(engine.detail(sid).run.sessions.yoon.threadId, usedId);
    assert.equal(engine.detail(sid).invocations.length, 1);
  } finally { await engine.close(); store.close(); }
});
test('API accepts local controls and rejects foreign-origin mutation', async () => {
  const { engine, store } = setup('batched_on_turn'); const app = await createApp(engine);
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/health', headers: { host: 'localhost:4317' } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/api/experiments', headers: { host: 'localhost:4317', origin: 'https://example.com' }, payload: {} })).statusCode, 403);
    const result = await app.inject({ method: 'GET', url: '/api/example', headers: { host: 'localhost:4317' } }); assert.equal(result.statusCode, 200); assert.equal(result.json().schemaVersion, 1);
  } finally { await app.close(); await engine.close(); store.close(); }
});
