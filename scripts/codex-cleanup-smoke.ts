import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CodexAdapter } from '../src/adapters/codex.js';
import { Engine } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
import { exampleSpec } from '../src/shared/example.js';
import { interruptTest, stopTestRuns, TestSessions } from './lib/test-sessions.js';

// Seven real calls cover natural completion, an explicit stop and one disposable sample.
const root = resolve('.cache', `history-test-codex-cleanup-${Date.now()}`); mkdirSync(root, { recursive: true });
const adapter = new CodexAdapter(join(root, 'runtime')), store = new Store(join(root, 'npc-lab.sqlite'));
const engine = new Engine(store, adapter, root), removeSignals = interruptTest(() => engine);
let transient: TestSessions | undefined;
try {
  const models = await adapter.models(), model = models.find(m => m.id === 'gpt-6-luna') ?? models[0];
  const config = { model: model.id, effort: model.efforts.includes('low') ? 'low' : model.defaultEffort };
  const spec = exampleSpec(config.model, config.effort); delete spec.scenario.environment;
  spec.variants = [{ ...spec.variants[0], turnPolicy: 'director' }]; spec.maxUtterances = 3; spec.evaluation.enabled = false;
  const { runs: [run] } = await engine.create(spec, false);
  await engine.resume(run.id, true); await engine.idle();
  assert.equal(engine.run(run.id).status, 'paused'); assert.equal(Object.keys(engine.run(run.id).sessionCleanup ?? {}).length, 0);
  const firstSpeakerThread = store.list('invocations', run.id).find(c => c.kind === 'speech')!.threadId;
  await adapter.close(); // Reopen the real CLI process before resuming memory.
  await engine.resume(run.id, true); await engine.idle();
  assert.equal(engine.detail(run.id).summary.speechCount, 2, engine.run(run.id).error ?? 'Speech failed');
  assert.ok(Object.values(engine.run(run.id).sessions).some(s => s.threadId === firstSpeakerThread));
  const director = store.list('invocations', run.id).find(c => c.kind === 'director')!;
  assert.equal(engine.run(run.id).sessionCleanup?.[director.threadId]?.status, 'deleted');
  assert.equal(await adapter.deleteSession(director.threadId, join(root, 'sessions', run.id)), 'missing');
  await engine.resume(run.id); await engine.idle();
  assert.equal(engine.run(run.id).status, 'completed', engine.run(run.id).error ?? '');
  const directors = store.list('invocations', run.id).filter(c => c.kind === 'director');
  assert.equal(directors.length, 2); assert.notEqual(directors[0].threadId, directors[1].threadId);
  const { runs: [interrupted] } = await engine.create(spec, false);
  await engine.resume(interrupted.id, true); await engine.idle(); await engine.stop(interrupted.id);
  assert.equal(engine.run(interrupted.id).status, 'stopped');
  let engineSessions = 0;
  for (const runId of [run.id, interrupted.id]) {
    const state = engine.run(runId).sessionCleanup!;
    for (const session of Object.values(engine.run(runId).sessions)) assert.equal(state[session.threadId]?.status, 'deleted');
    for (const id of Object.keys(state)) assert.equal(await adapter.deleteSession(id, join(root, 'sessions', runId)), 'missing');
    engineSessions += Object.keys(state).length;
  }
  transient = new TestSessions(adapter, root);
  const id = await transient.create(config, 'Return only the requested JSON.');
  const result = await adapter.turn({ threadId: id, config, input: 'Return {"ok":true}.', outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }, clientMessageId: randomUUID(), timeoutMs: 60_000 }, () => {}, transient.signal);
  writeFileSync(join(root, 'response.json'), JSON.stringify({ threadId: id, result }, null, 2));
  assert.equal(result.status, 'completed');
  const empty = await transient.create(config, 'Unused session cleanup test.');
  assert.equal(await adapter.deleteSession(id, root), 'missing');
  assert.deepEqual(await transient.close(), []);
  for (const thread of [id, empty]) assert.equal(await adapter.deleteSession(thread, root), 'missing');
  const report = { status: 'passed', cliVersion: adapter.version, model: config, calls: store.list('invocations').length + 1,
    engineSessions, transientSessions: 2, completed: engine.run(run.id).status, stopped: engine.run(interrupted.id).status, directorSessions: directors.length };
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ ...report, root }));
} finally { await transient?.close(); await stopTestRuns(engine); await removeSignals(); await engine.close(); store.close(); }
