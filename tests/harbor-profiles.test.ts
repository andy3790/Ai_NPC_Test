import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { exampleSpec } from '../src/shared/example.js';
import { spatialExample } from '../src/shared/spatial-example.js';
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
  assert.deepEqual(exampleSpec('mock-model'), exampleSpec('mock-model', 'low', 'harbor-profile/5'));
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

test('profile 3 inherits profile 2 while changing only Yoon and Miru goals, delivery and examples', () => {
  assert.equal(sha256(JSON.stringify(harborProfilePolicies['harbor-profile/3'])), 'cd401120a56394594b52628f18f951756086fb817c418918426af6cc72a4815f');
  const baseline = exampleSpec('mock-model', 'low', 'harbor-profile/2');
  const candidate = exampleSpec('mock-model', 'low', 'harbor-profile/3');
  assert.equal(candidate.scenario.id, 'fog-harbor-profile3');
  for (const c of candidate.scenario.characters) {
    const original = baseline.scenario.characters.find(a => a.id === c.id)!;
    if (c.id === 'doha') assert.deepEqual(c, original);
    const { goals: _g, speechStyle: _s, exampleDialogue: _e, ...rest } = c;
    assert.deepEqual(rest, Object.fromEntries(Object.entries(original).filter(([key]) => !['goals', 'speechStyle', 'exampleDialogue'].includes(key))));
  }
  const withoutCast = (s: typeof baseline) => ({ ...s, scenario: { ...s.scenario, id: '<version>', characters: [] } });
  assert.deepEqual(withoutCast(candidate), withoutCast(baseline));
});

test('profile 4 preserves the frozen profile 3 except Miru motivation and delivery', () => {
  assert.equal(sha256(JSON.stringify(harborProfilePolicies['harbor-profile/4'])), 'a09fd8b01e6155084b055f2cab0bf703e17133b358408d6fbc02b44d8619fa2e');
  const baseline = exampleSpec('mock-model', 'low', 'harbor-profile/3');
  const candidate = exampleSpec('mock-model', 'low', 'harbor-profile/4');
  assert.equal(candidate.scenario.id, 'fog-harbor-profile4');
  for (const c of candidate.scenario.characters) {
    const original = baseline.scenario.characters.find(a => a.id === c.id)!;
    if (c.id !== 'miru') assert.deepEqual(c, original);
    const { goals: _g, speechStyle: _s, ...rest } = c;
    assert.deepEqual(rest, Object.fromEntries(Object.entries(original).filter(([key]) => !['goals', 'speechStyle'].includes(key))));
  }
  const withoutCast = (s: typeof baseline) => ({ ...s, scenario: { ...s.scenario, id: '<version>', characters: [] } });
  assert.deepEqual(withoutCast(candidate), withoutCast(baseline));
});

test('profile 5 removes common directions while preserving individual facts and voice examples', () => {
  assert.equal(sha256(JSON.stringify(harborProfilePolicies['harbor-profile/5'])), 'e33bcc9d987dddb3a37e23ad2b3cd2b143f1d5a54f5a97a06839043db31af2bf');
  const before = exampleSpec('mock-model', 'low', 'harbor-profile/4').scenario.characters;
  const after = exampleSpec('mock-model').scenario.characters;
  const unchanged = ({ goals, speechStyle, behaviors, ...rest }: typeof after[number]) => rest;
  assert.deepEqual(after.map(unchanged), before.map(unchanged));
  assert.ok(after.every((c, i) => c.goals.length + c.speechStyle.length + c.behaviors.length <
    before[i].goals.length + before[i].speechStyle.length + before[i].behaviors.length));
});

test('new examples select available models and reasoning per role and preserve saved config', async () => {
  const model = (id: string, efforts = ['low'], isDefault = false): ModelInfo => ({ id, name: id, efforts, defaultEffort: efforts[0], isDefault });
  const config = (model: string, effort = 'low') => ({ model, effort });
  const terra = 'gpt-6.1-terra', luna = 'gpt-6-luna', sol = 'gpt-6.1-sol';
  for (const [adapterName, available, npc, director, world] of [
    ['openai', [model(sol, ['high'], true), model(luna, ['low', 'medium']), model(terra)], config(luna), config(luna), config(luna, 'medium')],
    ['openai', [model(luna, ['low'], true), model(sol)], config(luna), config(luna), config(luna)],
    ['openai', [model(luna, ['none'], true)], config(luna, 'none'), config(luna, 'none'), config(luna, 'none')],
    ['openai', [model(sol, ['medium'], true)], config(luna), config(luna), config(luna, 'medium')],
    ['codex', [model('mock-model', ['low'], true), model(luna), model(terra)], config(luna), config(luna), config(luna)],
  ] as const) {
    const store = new Store(':memory:'), adapter = new MockAdapter();
    adapter.name = adapterName; adapter.models = async () => [...available];
    const engine = new Engine(store, adapter, '.cache/history-test-example-models'), app = await createApp(engine);
    const saved = exampleSpec('mock-model', 'low', 'harbor-profile/1'); store.setting('lastSpec', saved);
    try {
      const response = await app.inject({ method: 'GET', url: '/api/example', headers: { host: 'localhost:4317' } });
      assert.equal(response.statusCode, 200);
      const spec = response.json();
      assert.deepEqual(spec.scenario.defaults, npc);
      assert.deepEqual(spec.director, director); assert.deepEqual(spec.worldEngine, world);
      assert.deepEqual(config(spec.evaluation.model, spec.evaluation.effort), director);
      assert.equal(spec.scenario.id, 'fog-harbor-profile5');
      if (adapterName === 'openai') {
        assert.equal(spec.maxUtterances, 18); assert.equal(spec.maxConcurrentCalls, 1);
        assert.ok(spec.variants.every((v: any) => v.turnPolicy === 'director'));
      }
      assert.deepEqual(store.setting('lastSpec'), saved); assert.equal(engine.list().length, 0);
    } finally { await app.close(); await engine.close(); store.close(); }
  }
});

test('new presets use independent role defaults and explicit adapter overrides still work', () => {
  for (const spec of [exampleSpec(), spatialExample()]) {
    assert.deepEqual(spec.scenario.defaults, { model: 'gpt-6-luna', effort: 'low' });
    assert.deepEqual(spec.worldEngine, { model: 'gpt-6-luna', effort: 'medium' });
    assert.deepEqual(spec.director, { model: 'gpt-6-luna', effort: 'low' });
  }
  const mock = spatialExample('mock-model', 'high');
  assert.deepEqual(mock.worldEngine, { model: 'mock-model', effort: 'high' });
  assert.deepEqual(mock.director, mock.worldEngine);
  const roles = { worldEngine: { model: 'available-world', effort: 'medium' }, director: { model: 'available-director', effort: 'low' } };
  const edited = spatialExample('selected-npc', 'high', roles);
  assert.deepEqual(edited.scenario.defaults, { model: 'selected-npc', effort: 'high' });
  assert.deepEqual(edited.worldEngine, roles.worldEngine);
  assert.deepEqual(edited.director, roles.director);
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

test('refinement comparison freezes identical observations and changes only the current speaker profile', () => {
  const load = (n: number) => dialogueCasesSchema.parse(JSON.parse(readFileSync(new URL('../evals/dialogue/harbor-refinement-profile' + n + '.json', import.meta.url), 'utf8'))).cases;
  const before = load(2), after = load(3);
  assert.equal(before.length, 16); assert.equal(after.length, before.length);
  assert.equal(before.filter(c => c.split === 'holdout').length, 10);
  for (const c of before) {
    const candidate = after.find(a => a.id === c.id)!;
    validateProfilePair(c, candidate);
    const original = caseInput(c, 'npc-dialogue/5', 'mock-model', 'low');
    const revised = caseInput(candidate, 'npc-dialogue/5', 'mock-model', 'low');
    assert.equal(original.input, revised.input); assert.notEqual(original.instructions, revised.instructions);
    for (const [version, fixture] of [[2, c], [3, candidate]] as const) {
      assert.deepEqual(fixture.characters.find(a => a.id === c.speakerId), exampleSpec('mock-model', 'low', `harbor-profile/${version}`).scenario.characters.find(a => a.id === c.speakerId));
    }
  }
});

test('followup and fresh transfer fixtures match the adopted profile without changing observations', () => {
  for (const [suite, count] of [['harbor-followup', 10], ['harbor-transfer', 6]] as const) {
    const load = (n: number) => dialogueCasesSchema.parse(JSON.parse(readFileSync(new URL('../evals/dialogue/' + suite + '-profile' + n + '.json', import.meta.url), 'utf8'))).cases;
    const before = load(2), after = load(4);
    assert.equal(before.length, count); assert.equal(after.length, count);
    if (suite === 'harbor-transfer') assert.ok(before.every(c => c.split === 'holdout'));
    for (const c of before) {
      const candidate = after.find(a => a.id === c.id)!;
      validateProfilePair(c, candidate);
      const original = caseInput(c, 'npc-dialogue/5', 'mock-model', 'low');
      const revised = caseInput(candidate, 'npc-dialogue/5', 'mock-model', 'low');
      assert.equal(original.input, revised.input); assert.notEqual(original.instructions, revised.instructions);
      for (const [version, fixture] of [[2, c], [4, candidate]] as const) {
        assert.deepEqual(fixture.characters.find(a => a.id === c.speakerId), exampleSpec('mock-model', 'low', `harbor-profile/${version}`).scenario.characters.find(a => a.id === c.speakerId));
      }
    }
  }
});
