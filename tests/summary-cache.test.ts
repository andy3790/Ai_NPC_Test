import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store } from '../src/core/store.js';
import { Engine } from '../src/core/engine.js';
import { MockAdapter } from '../src/adapters/mock.js';
import { RunHistoryCatalog } from '../src/core/history.js';
import { createApp } from '../src/server/app.js';
import { exampleSpec } from '../src/shared/example.js';
import { emptyUsage } from '../src/core/metrics.js';
import type { AdapterEvent } from '../src/adapters/types.js';
import type { RunListItem, RunSummary, Utterance } from '../src/shared/types.js';
import { historyFixture } from './history-fixture.js';

function specification() {
  const spec = exampleSpec('mock-model');
  delete spec.scenario.environment;
  spec.variants = [spec.variants[0]]; spec.maxUtterances = 3; spec.evaluation.interval = 3;
  return spec;
}

function setup() {
  const store = new Store(':memory:'), adapter = new MockAdapter(); adapter.delayMs = 0;
  const engine = new Engine(store, adapter, '.cache/summary-cache-unused');
  return { store, adapter, engine };
}

function watchRecordReads(store: Store) {
  const reads: { table: string; runId?: string }[] = [];
  const list = store.list.bind(store);
  store.list = ((table: Parameters<Store['list']>[0], runId?: string) => {
    if (table !== 'runs') reads.push({ table, runId });
    return list(table, runId);
  }) as Store['list'];
  return reads;
}

async function completed(engine: Engine) {
  const id = (await engine.create(specification())).runs[0].id;
  await engine.idle();
  return id;
}

test('run list API never builds details and reuses unchanged run aggregations', async () => {
  const { store, engine } = setup();
  const app = await createApp(engine);
  try {
    const first = await completed(engine), second = await completed(engine);
    const reads = watchRecordReads(store);
    engine.detail = () => { throw new Error('List must not request detailed records.'); };
    const response = await app.inject('/api/runs');
    assert.equal(response.statusCode, 200);
    const initial = response.json<RunListItem[]>();
    assert.equal(initial.length, 2);
    assert.ok(initial.every(item => item.summary.speechCount === 3 && item.maxUtterances === 3));
    assert.ok(initial.every(item => !Object.hasOwn(item, 'spec') && !Object.hasOwn(item, 'sessions') && !Object.hasOwn(item, 'helperSessions')));
    assert.equal(reads.length, 10, 'cold summaries load each run once');
    const before = reads.length;
    assert.deepEqual((await app.inject('/api/runs')).json(), initial);
    assert.equal(reads.length, before, 'warm lists must not load or reaggregate detailed records');
    const revision = store.revision(first);
    store.event(first, null, 'audit/only', { message: 'No summary fields changed.' });
    store.setting('unrelated', { value: 1 });
    store.put('runs', engine.run(first));
    assert.equal(store.revision(first), revision);
    await app.inject('/api/runs');
    assert.equal(reads.length, before, 'audit events, settings and identical writes do not invalidate summaries');
    store.patch('runs', second, { name: 'Changed run' });
    const changed = (await app.inject('/api/runs')).json<RunListItem[]>();
    assert.equal(changed.find(item => item.id === second)?.name, 'Changed run');
    assert.equal(reads.length, before + 5);
    assert.ok(reads.slice(before).every(read => read.runId === second), 'only the changed run is aggregated again');
    const filtered = await app.inject('/api/runs?provider=real');
    assert.deepEqual(filtered.json(), []);
    assert.equal(reads.length, before + 5);
  } finally { await app.close(); await engine.close(); store.close(); }
});

test('review, receipts, evaluation ranges, usage and utterance mutations invalidate their summary', async () => {
  const { store, engine } = setup();
  try {
    const id = await completed(engine);
    const detail = engine.detail(id);
    const original = engine.summary(id);
    const finding = { id: 'summary-finding', runId: id, evaluationId: detail.evaluations[0].id,
      utteranceId: detail.utterances[0].id, category: 'repetition', severity: 'low', verdict: 'issue',
      quote: '기름', reference: 'scenario', explanation: 'fixture', review: 'unreviewed' as const, note: '' };
    const reads = watchRecordReads(store);
    const check = (mutate: () => void, verify: (summary: RunSummary) => void) => {
      const before = reads.length;
      mutate();
      const summary = engine.summary(id);
      verify(summary);
      assert.equal(reads.length, before + 5);
      assert.deepEqual(engine.summary(id), summary);
      assert.equal(reads.length, before + 5, 'a second read reuses the changed summary');
      assert.deepEqual(engine.detail(id).summary, summary, 'list and detail use identical aggregation');
    };
    check(() => store.put('findings', finding), summary => {
      assert.equal(summary.issueRate, 1 / 3); assert.equal(summary.quality.semanticRepetition.rate, 1 / 3);
    });
    check(() => engine.review(finding.id, { review: 'confirmed', note: 'checked' }), summary => assert.equal(summary.confirmedIssues, 1));
    check(() => engine.review(finding.id, { review: 'dismissed' }), summary => {
      assert.equal(summary.issueRate, 0); assert.equal(summary.quality.semanticRepetition.rate, 0);
    });
    check(() => store.remove('findings', finding.id), summary => assert.deepEqual(summary.categories, {}));
    const pending = detail.receipts.find(receipt => receipt.status === 'pending')!;
    check(() => store.patch('receipts', pending.id, { status: 'delivered' }), summary => assert.equal(summary.pendingReceipts, original.pendingReceipts - 1));
    check(() => store.patch('evaluations', detail.evaluations[0].id, { status: 'failed' }), summary => {
      assert.equal(summary.evaluatedUtterances, 0); assert.equal(summary.evaluationFailures, 1);
      assert.equal(summary.quality.semanticRepetition.rate, null);
    });
    check(() => store.remove('evaluations', detail.evaluations[0].id), summary => assert.equal(summary.evaluationFailures, 0));
    const call = detail.invocations[0];
    check(() => store.patch('invocations', call.id, { usage: emptyUsage(), usageStatus: 'unknown_baseline' }), summary => {
      assert.equal(summary.missingUsage, original.missingUsage + 1);
      assert.equal(summary.tokens.totalTokens, original.tokens.totalTokens! - call.usage.totalTokens!);
    });
    const added: Utterance = { ...detail.utterances[0], id: 'added-speech', sequence: 4, speechIndex: 4 };
    check(() => store.put('utterances', added), summary => assert.equal(summary.speechCount, 4));
    check(() => store.remove('utterances', added.id), summary => assert.equal(summary.speechCount, 3));
    const isolated = engine.summary(id); isolated.tokens.totalTokens = -1; isolated.quality.repetition.matches.push({ utteranceId: 'bad', speechIndex: 0, previousUtteranceId: 'bad', previousSpeechIndex: 0, similarity: 1 });
    assert.notEqual(engine.summary(id).tokens.totalTokens, -1);
    assert.ok(engine.summary(id).quality.repetition.matches.every(match => match.utteranceId !== 'bad'));
  } finally { await engine.close(); store.close(); }
});

test('late usage events refresh summaries after a model call and run have completed', async () => {
  const { store, adapter, engine } = setup();
  let lateEvent: ((event: AdapterEvent) => void) | undefined;
  const turn = adapter.turn.bind(adapter);
  adapter.turn = async (request, emit, signal) => { lateEvent = emit; return turn(request, emit, signal); };
  try {
    const spec = specification(); spec.maxUtterances = 1; spec.evaluation.enabled = false;
    const id = (await engine.create(spec)).runs[0].id; await engine.idle();
    const before = engine.summary(id), call = store.list('invocations', id)[0];
    const total = { ...adapter.totals.get(call.threadId)! };
    total.inputTokens! += 12; total.outputTokens! += 13; total.totalTokens! += 25;
    const revision = store.revision(id);
    lateEvent!({ method: 'thread/tokenUsage/updated', params: { threadId: call.threadId, turnId: call.turnId, tokenUsage: { total } } });
    const after = engine.summary(id);
    assert.ok(store.revision(id) > revision);
    assert.equal(after.tokens.totalTokens, before.tokens.totalTokens! + 25);
    assert.equal(store.get('invocations', call.id)?.utteranceId, call.utteranceId);
    assert.equal(store.get('invocations', call.id)?.status, 'completed');
    assert.deepEqual(engine.detail(id).summary, after);
  } finally { await engine.close(); store.close(); }
});

test('rollback discards summaries calculated from uncommitted records', async () => {
  const { store, engine } = setup();
  try {
    const first = await completed(engine), second = await completed(engine);
    const original = engine.summary(first); engine.summary(second);
    const utterance = store.list('utterances', first)[0];
    const reads = watchRecordReads(store);
    assert.throws(() => store.transaction(() => {
      store.put('utterances', { ...utterance, id: 'uncommitted', sequence: 4, speechIndex: 4 });
      assert.equal(engine.summary(first).speechCount, 4);
      throw new Error('rollback fixture');
    }), /rollback fixture/);
    const before = reads.length;
    assert.deepEqual(engine.summary(first), original);
    assert.equal(reads.length, before + 5, 'rollback invalidates the temporary aggregation');
    engine.summary(second);
    assert.equal(reads.length, before + 5, 'rollback does not invalidate other runs');
    assert.equal(store.get('utterances', 'uncommitted'), undefined);
    assert.throws(() => store.transaction(() => {
      store.remove('utterances', utterance.id);
      assert.equal(engine.summary(first).speechCount, 2);
      throw new Error('rollback removal');
    }), /rollback removal/);
    assert.deepEqual(engine.summary(first), original);
  } finally { await engine.close(); store.close(); }
});

test('paused timing changes without invalidating cached aggregation', async t => {
  const { store, engine } = setup();
  try {
    const id = (await engine.create(specification(), false)).runs[0].id;
    const clock = Date.now();
    store.patch('runs', id, { startedAt: new Date(clock - 5_000).toISOString(), pausedAt: new Date(clock - 1_000).toISOString(), pausedMs: 300, activeMs: 700 });
    let currentClock = clock; t.mock.method(Date, 'now', () => currentClock);
    const before = engine.summary(id), revision = store.revision(id);
    const reads = watchRecordReads(store);
    currentClock = clock + 60_000;
    const after = engine.summary(id);
    assert.equal(after.elapsedMs - before.elapsedMs, 60_000);
    assert.equal(after.pausedMs - before.pausedMs, 60_000);
    assert.equal(after.activeMs, 700);
    assert.equal(reads.length, 0); assert.equal(store.revision(id), revision);
    store.patch('runs', id, { status: 'stopped', completedAt: new Date(clock + 60_000).toISOString(), pausedAt: null, pausedMs: after.pausedMs });
    const stopped = engine.summary(id);
    currentClock = clock + 120_000;
    assert.deepEqual(engine.summary(id), stopped);
  } finally { await engine.close(); store.close(); }
});

test('active timing advances while a model request produces no new events', async () => {
  const { store, adapter, engine } = setup();
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const turn = adapter.turn.bind(adapter);
  adapter.turn = async (...args) => { entered(); await gate; return turn(...args); };
  try {
    const spec = specification(); spec.maxUtterances = 1; spec.evaluation.enabled = false;
    const id = (await engine.create(spec)).runs[0].id;
    await started;
    const before = engine.summary(id), revision = store.revision(id);
    const reads = watchRecordReads(store);
    await new Promise(resolve => setTimeout(resolve, 20));
    const after = engine.summary(id);
    assert.ok(after.activeMs > before.activeMs); assert.ok(after.elapsedMs > before.elapsedMs);
    assert.equal(store.revision(id), revision); assert.equal(reads.length, 0);
    assert.equal(after.pendingCalls, 1);
    release(); await engine.idle();
    assert.equal(engine.summary(id).pendingCalls, 0);
    assert.equal(engine.run(id).status, 'completed');
  } finally { release(); await engine.close(); store.close(); }
});

test('restart recovery and reconciliation invalidate run and invocation summaries', async () => {
  const { store, adapter, engine } = setup();
  let recovered: Engine | undefined;
  try {
    const id = await completed(engine), call = store.list('invocations', id)[0];
    store.patch('runs', id, { status: 'running', completedAt: null, pausedAt: null });
    store.patch('invocations', call.id, { status: 'running' });
    store.put('invocations', { ...call, id: 'queued-before-restart', operationKey: 'unused', status: 'queued', startedAt: null, usage: emptyUsage() });
    assert.equal(engine.summary(id).pendingCalls, 2);
    recovered = new Engine(store, adapter, '.cache/summary-recovery-unused');
    const paused = recovered.summary(id);
    assert.equal(paused.pendingCalls, 0); assert.equal(paused.failed, 2); assert.equal(paused.timingComplete, false);
    assert.equal(engine.summary(id).failed, 2, 'recovery writes invalidate caches sharing this Store');
    await recovered.resume(id); await recovered.idle();
    const finished = recovered.summary(id);
    assert.equal(finished.failed, 1); assert.equal(finished.pendingCalls, 0);
    assert.equal(finished.timingComplete, false); assert.equal(recovered.run(id).status, 'completed');
    assert.deepEqual(recovered.detail(id).summary, finished);
  } finally { await recovered?.close(); await engine.close(); store.close(); }
});

test('history lists use current cached summaries and preserve archived snapshot timing and null usage', async t => {
  mkdirSync('.cache', { recursive: true });
  const workspace = mkdtempSync(resolve('.cache/history-test-summary-'));
  const foreignPath = join(workspace, 'reports/old/npc-lab.sqlite');
  const fixture = await historyFixture(foreignPath, 'openai');
  const source = new Store(foreignPath);
  source.patch('runs', fixture.detail.run.id, { status: 'paused', completedAt: null, pausedAt: new Date(Date.now() - 1_000).toISOString() });
  for (const call of source.list('invocations', fixture.detail.run.id)) source.patch('invocations', call.id, { usage: emptyUsage(), usageStatus: 'unknown_baseline' });
  source.close();
  const { store, engine } = setup();
  const currentId = (await engine.create(specification(), false)).runs[0].id;
  const history = new RunHistoryCatalog(engine, { workspace });
  const app = await createApp(engine, { history });
  const originalDetail = engine.detail.bind(engine);
  try {
    const reads = watchRecordReads(store);
    engine.detail = () => { throw new Error('History lists must not request live detail.'); };
    const initialResponse = await app.inject('/api/runs');
    assert.equal(initialResponse.statusCode, 200);
    const initial = initialResponse.json<RunListItem[]>();
    const archived = initial.find(item => item.id === fixture.detail.run.id)!;
    const current = initial.find(item => item.id === currentId)!;
    assert.equal(archived.history?.readOnly, true); assert.equal(current.history?.readOnly, false);
    assert.equal(archived.summary.tokens.totalTokens, null);
    assert.equal(archived.summary.missingUsage, fixture.detail.invocations.length);
    assert.equal(reads.length, 5);
    const clock = Date.now(); t.mock.method(Date, 'now', () => clock + 60_000);
    const next = (await app.inject('/api/runs')).json<RunListItem[]>();
    assert.deepEqual(next.find(item => item.id === archived.id)?.summary, archived.summary);
    assert.ok(next.find(item => item.id === current.id)!.summary.pausedMs > current.summary.pausedMs);
    assert.equal(reads.length, 5);
    assert.equal((await app.inject('/api/runs?provider=openai')).json<RunListItem[]>().length, 1);
    const update = new Store(foreignPath); update.patch('findings', fixture.detail.findings[0].id, { review: 'dismissed' }); update.close();
    history.refresh();
    const refreshed = history.list().find(item => item.id === archived.id)!;
    assert.equal(refreshed.summary.issueRate, 0); assert.equal(refreshed.summary.tokens.totalTokens, null);
    assert.deepEqual(history.detail(archived.id).summary, refreshed.summary);
    assert.equal(reads.length, 5, 'archive refresh does not rebuild an unchanged live summary');
  } finally { engine.detail = originalDetail; await engine.close(); await app.close(); store.close(); }
});
