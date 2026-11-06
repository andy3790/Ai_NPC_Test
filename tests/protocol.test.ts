import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { CodexAdapter } from '../src/adapters/codex.js';
import { Engine } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
import { exampleSpec } from '../src/shared/example.js';
import { DIRECTOR_CONTEXT } from '../src/core/director.js';
test('late Codex usage remains attributed to committed speech without overwriting its link', async () => {
  const previous = process.env.CODEX_BIN; process.env.CODEX_BIN = resolve('tests/fixtures/fake-codex.mjs');
  const adapter = new CodexAdapter(resolve('.cache/protocol-fixture')); const store = new Store(':memory:'); const engine = new Engine(store, adapter, resolve('.cache/protocol-fixture'));
  try {
    const spec = exampleSpec('fixture'); spec.maxUtterances = 2; spec.variants = [spec.variants[0]]; spec.evaluation.enabled = false;
    const { runs } = await engine.create(spec, false); const id = runs[0].id;
    await engine.resume(id, true); await engine.idle();
    assert.equal(engine.detail(id).invocations[0].usage.totalTokens, null);
    await new Promise(r => setTimeout(r, 160));
    const d = engine.detail(id); assert.equal(d.invocations[0].usage.totalTokens, 120); assert.equal(d.invocations[0].status, 'completed');
    assert.equal(d.invocations[0].utteranceId, d.utterances[0].id); assert.equal(d.summary.missingUsage, 0);
    const call = d.invocations[0];
    const known = await adapter.reconcile(call.threadId, call.turnId, call.id);
    const unknown = await adapter.reconcile(call.threadId, null, call.id);
    assert.equal(known?.output, call.output); assert.equal(unknown?.turnId, call.turnId); assert.equal(unknown?.output, call.output);
    await engine.resume(id); await engine.idle();
    assert.equal(engine.run(id).status, 'completed');
    assert.ok(Object.values(engine.run(id).sessionCleanup ?? {}).every(c => c.status === 'deleted'));
    await assert.rejects(adapter.reconcile(call.threadId, call.turnId, call.id), /no rollout found/);
  } finally { await engine.close(); store.close(); if (previous === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = previous; }
});

test('Codex director decisions use new threads and retain late usage for every independent call', async () => {
  const previous = process.env.CODEX_BIN; process.env.CODEX_BIN = resolve('tests/fixtures/fake-codex.mjs');
  const root = resolve('.cache/protocol-director-fixture'), adapter = new CodexAdapter(root), store = new Store(':memory:');
  const engine = new Engine(store, adapter, root);
  try {
    const spec = exampleSpec('fixture'); delete spec.scenario.environment;
    spec.maxUtterances = 6; spec.variants = [{ ...spec.variants[0], turnPolicy: 'director' }]; spec.evaluation.enabled = false;
    const { runs: [run] } = await engine.create(spec); await engine.idle();
    await new Promise(r => setTimeout(r, 160)); const d = engine.detail(run.id);
    assert.equal(d.run.status, 'completed', d.run.error ?? '');
    const calls = d.invocations.filter(c => c.kind === 'director'); assert.equal(calls.length, 5);
    assert.equal(new Set(calls.map(c => c.threadId)).size, 5);
    assert.equal(new Set(d.invocations.filter(c => c.kind === 'speech').map(c => c.threadId)).size, 3);
    for (const call of calls) {
      assert.ok(call.input.length <= DIRECTOR_CONTEXT.maxInputCharacters);
      assert.equal(call.usage.totalTokens, 120); assert.ok(call.durationMs! >= 0);
      assert.equal(call.usageStatus, 'reported_cumulative_delta');
    }
    assert.equal(d.summary.byKind.director.tokens.totalTokens, 600);
    for (const call of d.invocations) assert.equal(d.run.sessionCleanup?.[call.threadId]?.status, 'deleted');
  } finally { await engine.close(); store.close(); if (previous === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = previous; }
});
