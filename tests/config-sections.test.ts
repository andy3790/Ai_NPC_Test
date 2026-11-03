import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exampleSpec } from '../src/shared/example.js';
import { applyConfigSection, readConfigSection, type ConfigSection } from '../src/shared/config-sections.js';

test('JSON section reads are detached and all five scopes round-trip without losing fields', () => {
  const spec = exampleSpec('mock-model');
  for (const scope of ['full', 'world', 'character', 'characters', 'conditions'] as ConfigSection[]) {
    const value = readConfigSection(spec, scope, 1);
    assert.deepEqual(applyConfigSection(spec, scope, value, 1), spec, scope);
  }
  const profile = readConfigSection(spec, 'character', 1) as any; profile.memories = '편집 초안';
  assert.notEqual(profile.memories, spec.scenario.characters[1].memories);
});

test('world replacement preserves every character and experiment condition, and can remove optional environment', () => {
  const spec = exampleSpec('mock-model'); const original = structuredClone(spec);
  const world = readConfigSection(spec, 'world') as any; world.world = '수정된 세계 설정'; world.name = '새 장면'; delete world.environment;
  const next = applyConfigSection(spec, 'world', world);
  assert.equal(next.scenario.world, world.world); assert.equal(next.scenario.name, world.name); assert.equal(next.scenario.environment, undefined);
  assert.deepEqual(next.scenario.characters, spec.scenario.characters);
  const { scenario: _one, ...rest } = spec; const { scenario: _two, ...after } = next; assert.deepEqual(after, rest);
  assert.deepEqual(spec, original); assert.throws(() => applyConfigSection(spec, 'world', { ...world, characters: [] }), /Unrecognized key/);
});

test('single character editing preserves other NPCs and rejects invalid environment references atomically', () => {
  const spec = exampleSpec('mock-model'), original = structuredClone(spec);
  const profile = readConfigSection(spec, 'character', 1) as any;
  profile.speechStyle = '느긋한 반말'; profile.behaviors = '고개를 기울인다.';
  const next = applyConfigSection(spec, 'character', profile, 1);
  assert.equal(next.scenario.characters[1].speechStyle, profile.speechStyle);
  assert.deepEqual(next.scenario.characters[0], spec.scenario.characters[0]); assert.deepEqual(next.scenario.characters[2], spec.scenario.characters[2]);
  assert.deepEqual(next.scenario.environment, spec.scenario.environment);
  assert.throws(() => applyConfigSection(spec, 'character', { ...profile, id: 'renamed' }, 1), /알 수 없는 행동 수행자/);
  assert.throws(() => applyConfigSection(spec, 'character', { ...profile, id: spec.scenario.characters[0].id }, 1), /중복/);
  assert.throws(() => applyConfigSection(spec, 'character', { ...profile, speech_style: '잘못된 키' }, 1), /Unrecognized key/);
  assert.throws(() => readConfigSection(spec, 'character', 999), /선택/); assert.deepEqual(spec, original);
});

test('all-character replacement preserves order and rejects duplicates, too few NPCs, and dangling actors', () => {
  const spec = exampleSpec('mock-model'), characters = readConfigSection(spec, 'characters') as typeof spec.scenario.characters;
  const next = applyConfigSection(spec, 'characters', [characters[2], characters[0], characters[1]]);
  assert.deepEqual(next.scenario.characters.map(c => c.id), ['miru','yoon','doha']);
  assert.deepEqual(next.scenario.environment, spec.scenario.environment); assert.deepEqual(next.variants, spec.variants);
  assert.throws(() => applyConfigSection(spec, 'characters', [characters[0], characters[0]]), /중복/);
  assert.throws(() => applyConfigSection(spec, 'characters', [characters[0]]));
  assert.throws(() => applyConfigSection(spec, 'characters', [characters[0], characters[1]]), /알 수 없는 행동 수행자/);
});

test('conditions replacement preserves canon, validates total run count, and full JSON still supports coordinated edits', () => {
  const spec = exampleSpec('mock-model'), conditions = readConfigSection(spec, 'conditions') as any;
  conditions.variants = [{ ...spec.variants[0], label: '한 조건' }]; conditions.maxUtterances = 120; conditions.repetitions = 2;
  conditions.evaluation.interval = 20; conditions.scheduledEvents = [{ afterUtterance: 10, text: '공개 사건' }];
  const next = applyConfigSection(spec, 'conditions', conditions);
  assert.equal(next.maxUtterances, 120); assert.equal(next.repetitions, 2); assert.equal(next.evaluation.interval, 20);
  assert.deepEqual(next.scenario, spec.scenario); assert.equal(next.name, spec.name);
  assert.throws(() => applyConfigSection(spec, 'conditions', { ...conditions, variants: Array.from({length: 6}, (_, i) => ({ ...spec.variants[0], id: `v${i}` })), repetitions: 100 }), /500/);
  assert.throws(() => applyConfigSection(spec, 'conditions', { ...conditions, maxUtterances: 0 }));
  assert.throws(() => applyConfigSection(spec, 'conditions', { ...conditions, scenario: spec.scenario }), /Unrecognized key/);
  const full = readConfigSection(spec, 'full') as typeof spec;
  full.scenario.characters[0].id = 'new-yoon';
  full.scenario.environment!.actions.forEach(a => { a.actorIds = a.actorIds.map(id => id === 'yoon' ? 'new-yoon' : id); });
  assert.equal(applyConfigSection(spec, 'full', full).scenario.characters[0].id, 'new-yoon');
});
