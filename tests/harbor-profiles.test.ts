import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { exampleSpec } from '../src/shared/example.js';
import { harborCharacter, harborProfilePolicies } from '../src/shared/harbor-profiles.js';
import { dialogueCasesSchema, sha256, validateProfilePair, caseInput } from '../scripts/lib/dialogue-eval.js';
import { Engine } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
import { MockAdapter } from '../src/adapters/mock.js';
import { createApp } from '../src/server/app.js';
import type { ModelInfo } from '../src/shared/types.js';

test('harbor profile revisions preserve the legacy cast and freeze authored changes', () => {
  const original = exampleSpec('mock-model', 'low', 'harbor-profile/1');
  assert.equal(sha256(JSON.stringify(original.scenario.characters)), 'bbfcec1921ae863dc20b1dc714510467e31837094ab66247586a33a75ce7ea57');
  assert.equal(sha256(JSON.stringify(harborProfilePolicies['harbor-profile/1'])), 'c1d8510e71515fea3395914e36b95673096570da1bb0bde433607cc76265aac6');
  assert.equal(sha256(JSON.stringify(harborProfilePolicies['harbor-profile/2'])), '837d048d27eb9f7dfc4a7826c5ca7e55a6ee94008c90bc1eb469cda98ba2de01');
  const revised = exampleSpec('mock-model', 'low', 'harbor-profile/2');
  assert.deepEqual(exampleSpec('mock-model'), revised);
  assert.deepEqual(revised.scenario.environment, original.scenario.environment);
  assert.equal(revised.scenario.world, original.scenario.world);
  assert.equal(revised.scenario.situation, original.scenario.situation);
  assert.equal(revised.scenario.id, 'fog-harbor-profile2');
  for (const c of revised.scenario.characters) {
    const before = original.scenario.characters.find(a => a.id === c.id)!;
    const { personality: _p, goals: _g, speechStyle: _s, exampleDialogue: _e, behaviors: _b, ...facts } = c;
    assert.deepEqual(facts, Object.fromEntries(Object.entries(before).filter(([k]) => !['personality', 'goals', 'speechStyle', 'exampleDialogue', 'behaviors'].includes(k))));
  }
  assert.throws(() => harborCharacter(original.scenario.characters[0], 'harbor-profile/999' as any), /Unknown harbor profile/);
});

test('new API examples prefer verified dialogue models only when available and preserve saved config', async () => {
  const model = (id: string, effort = 'low', isDefault = false): ModelInfo => ({ id, name: id, efforts: [effort], defaultEffort: effort, isDefault });
  for (const [adapterName, available, npc, helper, effort] of [
    ['openai', [model('gpt-6-luna', 'low', true), model('gpt-6.1-sol')], 'gpt-6.1-sol', 'gpt-6-luna', 'low'],
    ['openai', [model('gpt-6-luna', 'none', true)], 'gpt-6-luna', 'gpt-6-luna', 'none'],
    ['openai', [model('gpt-6.1-sol', 'medium', true)], 'gpt-6.1-sol', 'gpt-6.1-sol', 'medium'],
    ['codex', [model('mock-model', 'low', true), model('gpt-6.1-sol')], 'mock-model', 'mock-model', 'low'],
  ] as const) {
    const store = new Store(':memory:'), adapter = new MockAdapter();
    adapter.name = adapterName; adapter.models = async () => [...available];
    const engine = new Engine(store, adapter, '.cache/history-test-example-models'), app = await createApp(engine);
    const saved = exampleSpec('mock-model', 'low', 'harbor-profile/1'); store.setting('lastSpec', saved);
    try {
      const response = await app.inject({ method: 'GET', url: '/api/example', headers: { host: 'localhost:4317' } });
      assert.equal(response.statusCode, 200);
      const spec = response.json();
      assert.deepEqual(spec.scenario.defaults, { model: npc, effort });
      assert.equal(spec.director.model, helper); assert.equal(spec.evaluation.model, helper);
      assert.equal(spec.scenario.id, 'fog-harbor-profile2');
      if (adapterName === 'openai') {
        assert.equal(spec.maxUtterances, 18); assert.equal(spec.maxConcurrentCalls, 1);
        assert.ok(spec.variants.every((v: any) => v.turnPolicy === 'director'));
      }
      assert.deepEqual(store.setting('lastSpec'), saved); assert.equal(engine.list().length, 0);
    } finally { await app.close(); await engine.close(); store.close(); }
  }
});

test('paired profile fixtures keep observations and other actors fixed and reject confounded comparisons', () => {
  const load = (n: number) => dialogueCasesSchema.parse(JSON.parse(readFileSync(new URL('../evals/dialogue/harbor-profile' + n + '.json', import.meta.url), 'utf8'))).cases;
  const baseline = load(1), candidate = load(2);
  for (const c of baseline) {
    const other = candidate.find(o => o.id === c.id)!;
    validateProfilePair(c, other);
    const a = caseInput(c, 'npc-dialogue/5', 'mock-model', 'low'), b = caseInput(other, 'npc-dialogue/5', 'mock-model', 'low');
    assert.equal(a.input, b.input); assert.notEqual(a.instructions, b.instructions);
  }
  const c = baseline[0], other = candidate[0];
  assert.throws(() => validateProfilePair(c, { ...other, situation: 'Different public situation' }), /changed observations/);
  assert.throws(() => validateProfilePair(c, { ...other, characters: other.characters.map(a => a.id === c.speakerId ? a : { ...a, memories: 'Different other actor' }) }), /changed observations/);
  const onlyReview = { ...other, review: ['PRIVATE_REVIEW_SENTINEL'], characters: other.characters.map(a => a.id === c.speakerId ? a : { ...a, unknowns: 'OTHER_PRIVATE_SENTINEL' }) };
  const p = caseInput(onlyReview, 'npc-dialogue/5', 'mock-model', 'low');
  assert.doesNotMatch(p.instructions + p.input, /PRIVATE_REVIEW_SENTINEL|OTHER_PRIVATE_SENTINEL/);
});
