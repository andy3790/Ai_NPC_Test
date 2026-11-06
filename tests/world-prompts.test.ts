import { test } from 'node:test';
import assert from 'node:assert/strict';
import { worldPolicies, worldPromptVersion, WORLD_PROMPT_VERSION } from '../src/core/world-policies.js';
import { sha256 } from '../scripts/lib/dialogue-eval.js';
import { Store } from '../src/core/store.js';
import { Engine } from '../src/core/engine.js';
import { MockAdapter } from '../src/adapters/mock.js';
import { exampleSpec } from '../src/shared/example.js';
import { outputSchemas } from '../src/shared/schema.js';

test('world instruction revisions are immutable and unknown text is not attributed to the current revision', () => {
  const expected = {
    'npc-world/1': 'd95906ff5195d433b39a1086a9c157ee3319416f3612aa8fb56356250f6217e2',
    'npc-world/2': '71a8f03ede0bcb2e566ef419bbd66b318ea4e32f131393acb2196fe0c4839ded',
  };
  assert.deepEqual(Object.keys(worldPolicies), Object.keys(expected));
  for (const version of Object.keys(expected) as (keyof typeof expected)[]) {
    assert.equal(sha256(worldPolicies[version].instructions), expected[version]);
    assert.equal(worldPromptVersion(worldPolicies[version].instructions), version);
  }
  assert.equal(worldPromptVersion('old/custom instructions'), null);
});

test('world call provenance follows the persisted helper instructions after resume and hashes the sent schema', async () => {
  const store = new Store(':memory:'), adapter = new MockAdapter(), engine = new Engine(store, adapter, '.cache/world-prompt-test');
  const spec = exampleSpec('mock-model'); spec.maxUtterances = 2; spec.evaluation.enabled = false;
  spec.variants = [{ ...spec.variants[0], environmentMode: 'ai', deliveryMode: 'batched_on_turn' }];
  spec.worldEngine = { model: 'mock-model', effort: 'medium' };
  try {
    const { runs: [run] } = await engine.create(spec, false);
    await engine.resume(run.id, true); await engine.idle();
    const first = engine.detail(run.id);
    assert.equal(first.invocations.find(c => c.kind === 'environment')!.metadata.worldPromptVersion, WORLD_PROMPT_VERSION);
    const helpers = structuredClone(first.run.helperSessions);
    helpers['world-engine'].instructions = worldPolicies['npc-world/1'].instructions;
    adapter.instructions.set(helpers['world-engine'].threadId, helpers['world-engine'].instructions);
    store.patch('runs', run.id, { helperSessions: helpers });
    await engine.resume(run.id); await engine.idle();
    const detail = engine.detail(run.id);
    assert.equal(detail.run.status, 'completed', detail.run.error ?? '');
    const last = detail.invocations.filter(c => c.kind === 'environment').at(-1)!;
    assert.equal(last.metadata.worldPromptVersion, 'npc-world/1');
    assert.equal(last.metadata.instructionsSha256, sha256(worldPolicies['npc-world/1'].instructions));
    assert.equal(last.metadata.outputSchemaSha256, sha256(JSON.stringify(outputSchemas.environment)));
    assert.equal(detail.run.helperSessions['world-engine'].instructions, helpers['world-engine'].instructions);
  } finally { await engine.close(); store.close(); }
});
