import { test } from 'node:test';
import assert from 'node:assert/strict';
import { worldPolicies, worldPromptVersion, WORLD_PROMPT_VERSION } from '../src/core/world-policies.js';
import { sha256 } from '../scripts/lib/dialogue-eval.js';
import { Store } from '../src/core/store.js';
import { Engine } from '../src/core/engine.js';
import { MockAdapter } from '../src/adapters/mock.js';
import { exampleSpec } from '../src/shared/example.js';
import { outputSchemas } from '../src/shared/schema.js';
import { WORLD_PROMPT_VERSIONS, LEGACY_WORLD_PROMPT } from '../src/shared/world-policy.js';

test('world instruction revisions are immutable and unknown text is not attributed to the current revision', () => {
  const expected = {
    'npc-world/1': 'd95906ff5195d433b39a1086a9c157ee3319416f3612aa8fb56356250f6217e2',
    'npc-world/2': '71a8f03ede0bcb2e566ef419bbd66b318ea4e32f131393acb2196fe0c4839ded',
    'npc-world/3': 'd6cd33f95b9c0a14570d0e78d6c0ff7eadeadf8960ffee5f65639d75e8f1e13f',
    'npc-world/4': '2a83f78ee8084dbc841de3e02ddcafc7be53280bb7c311c9e1631c7af614811d',
  };
  assert.deepEqual(Object.keys(worldPolicies), Object.keys(expected));
  assert.deepEqual([...WORLD_PROMPT_VERSIONS], Object.keys(expected));
  for (const version of Object.keys(expected) as (keyof typeof expected)[]) {
    assert.equal(sha256(worldPolicies[version].instructions), expected[version]);
    assert.equal(worldPromptVersion(worldPolicies[version].instructions), version);
  }
  assert.equal(worldPromptVersion('old/custom instructions'), null);
});

test('new world runs pin their selected policy while an uninitialized legacy run uses the previous default', async () => {
  const store = new Store(':memory:'), adapter = new MockAdapter(), engine = new Engine(store, adapter, '.cache/world-policy-pin');
  const spec = exampleSpec('mock-model'); spec.maxUtterances = 1; spec.evaluation.enabled = false;
  spec.worldEngine = { model: 'mock-model', effort: 'medium' };
  const variant = { ...spec.variants[0], environmentMode: 'ai' as const, deliveryMode: 'batched_on_turn' as const };
  spec.variants = [{ ...variant, id: 'candidate', worldPromptVersion: 'npc-world/4' }, { ...variant, id: 'default' }, { ...variant, id: 'legacy' }];
  try {
    const { runs } = await engine.create(spec, false);
    assert.equal(runs[0].variant.worldPromptVersion, 'npc-world/4');
    assert.equal(runs[1].variant.worldPromptVersion, WORLD_PROMPT_VERSION);
    assert.equal(runs[1].spec.variants[1].worldPromptVersion, undefined);
    const old = { ...runs[2].variant }; delete old.worldPromptVersion;
    store.patch('runs', runs[2].id, { variant: old, promptVersion: 'npc-lab/8' });
    for (const [i, run] of runs.entries()) {
      await engine.resume(run.id); await engine.idle();
      const detail = engine.detail(run.id), selected = i === 2 ? LEGACY_WORLD_PROMPT : run.variant.worldPromptVersion!;
      assert.equal(detail.run.status, 'completed', detail.run.error ?? '');
      assert.equal(detail.run.helperSessions['world-engine'].instructions, worldPolicies[selected].instructions);
      assert.equal(detail.invocations.find(c => c.kind === 'environment')!.metadata.worldPromptVersion, selected);
    }
  } finally { await engine.close(); store.close(); }
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
