import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { CodexAdapter } from '../src/adapters/codex.js';
import { Engine } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
import { exampleSpec } from '../src/shared/example.js';
test('late Codex usage remains attributed to committed speech without overwriting its link', async () => {
  const previous = process.env.CODEX_BIN; process.env.CODEX_BIN = resolve('tests/fixtures/fake-codex.mjs');
  const adapter = new CodexAdapter(resolve('.cache/protocol-fixture')); const store = new Store(':memory:'); const engine = new Engine(store, adapter, resolve('.cache/protocol-fixture'));
  try {
    const spec = exampleSpec('fixture'); spec.maxUtterances = 1; spec.variants = [spec.variants[0]]; spec.evaluation.enabled = false;
    const { runs } = await engine.create(spec); await engine.idle(); const id = runs[0].id;
    assert.equal(engine.detail(id).invocations[0].usage.totalTokens, null);
    await new Promise(r => setTimeout(r, 160));
    const d = engine.detail(id); assert.equal(d.invocations[0].usage.totalTokens, 120); assert.equal(d.invocations[0].status, 'completed');
    assert.equal(d.invocations[0].utteranceId, d.utterances[0].id); assert.equal(d.summary.missingUsage, 0);
    const call = d.invocations[0];
    const known = await adapter.reconcile(call.threadId, call.turnId, call.id);
    const unknown = await adapter.reconcile(call.threadId, null, call.id);
    assert.equal(known?.output, call.output); assert.equal(unknown?.turnId, call.turnId); assert.equal(unknown?.output, call.output);
  } finally { await engine.close(); store.close(); if (previous === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = previous; }
});
