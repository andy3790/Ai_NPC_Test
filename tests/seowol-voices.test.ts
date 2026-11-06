import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { experimentSchema } from '../src/shared/schema.js';
import { persona } from '../src/core/prompts.js';
import { worldPrompt, initialWorldState } from '../src/core/world.js';
import type { Utterance } from '../src/shared/types.js';

const root = new URL('../assets/seowol/', import.meta.url);
const read = (file: string) => JSON.parse(readFileSync(new URL(file, root), 'utf8'));
const revised = experimentSchema.parse(read('experiments/strong-voices.json'));
const previous = experimentSchema.parse(read('experiments/strong-voices-baseline.json'));
const dinner = experimentSchema.parse(read('experiments/strong-voices-dinner.json'));

test('voice comparison holds world, private histories, cast, models and run limits constant', () => {
  const copy = structuredClone(previous);
  copy.name = revised.name;
  copy.variants[0].id = revised.variants[0].id;
  copy.variants[0].label = revised.variants[0].label;
  for (const [i, c] of copy.scenario.characters.entries()) c.speechStyle = revised.scenario.characters[i].speechStyle;
  assert.deepEqual(copy, revised);
  assert.equal(revised.maxUtterances, 18);
  assert.equal(revised.evaluation.enabled, false);
  assert.equal(revised.variants[0].eventGeneration, false);
});

test('new actors keep separate private perspectives while the engine can judge the actual damaged object', () => {
  const spec = structuredClone(revised);
  spec.scenario.characters[0].memories += '\nDOHA_PRIVATE_DROP';
  spec.scenario.characters[1].memories += '\nSOJIN_PRIVATE_VIDEO';
  spec.scenario.worldEngineInstructions += '\nAMPLIFIER_HIDDEN_CONTACT';
  const [doha, sojin, bokman] = spec.scenario.characters.map(c => persona(spec, c, spec.variants[0]));
  assert.match(doha, /DOHA_PRIVATE_DROP/);
  assert.doesNotMatch(doha, /SOJIN_PRIVATE_VIDEO|AMPLIFIER_HIDDEN_CONTACT/);
  assert.match(sojin, /SOJIN_PRIVATE_VIDEO/);
  assert.doesNotMatch(sojin, /DOHA_PRIVATE_DROP|AMPLIFIER_HIDDEN_CONTACT/);
  assert.doesNotMatch(bokman, /DOHA_PRIVATE_DROP|SOJIN_PRIVATE_VIDEO|AMPLIFIER_HIDDEN_CONTACT/);
  const source = { id: 's1', sequence: 1, speechIndex: 1, kind: 'speech', speakerId: 'test_baek_doha',
    speakerName: '백도하', speech: '이거 좀 봐.', action: '' } as Utterance;
  const engine = worldPrompt(spec, initialWorldState(), [source], source);
  assert.match(engine, /AMPLIFIER_HIDDEN_CONTACT/);
  assert.doesNotMatch(engine, /DOHA_PRIVATE_DROP|SOJIN_PRIVATE_VIDEO/);
});

test('the transfer scene starts fresh without carrying the amplifier incident into actor memories and goals', () => {
  assert.notEqual(dinner.scenario.id, revised.scenario.id);
  assert.deepEqual(dinner.scenario.characters.map(c => c.id), revised.scenario.characters.map(c => c.id));
  for (const c of dinner.scenario.characters) {
    assert.doesNotMatch([c.memories, c.goals, c.unknowns].join('\n'), /떨어뜨|테이프|빌려준 앰프|오늘 밤까지/);
  }
  assert.equal(dinner.scheduledEvents.length, 0);
  assert.equal(dinner.variants[0].model, revised.variants[0].model);
});
