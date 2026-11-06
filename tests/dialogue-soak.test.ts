import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepareConversations } from '../scripts/lib/dialogue-soak.js';

const options = { model: 'mock-model', effort: 'low', baseline: 'npc-dialogue/3', candidate: 'npc-dialogue/5',
  turns: 18, repetitions: 2, worldModel: 'mock-world', worldEffort: 'medium' } as const;
const fixture = JSON.parse(readFileSync(new URL('../evals/dialogue/observed-conversations.json', import.meta.url), 'utf8'))[0];

test('conversation comparisons preserve world, private profiles and scheduled events while budgeting world calls', () => {
  const input = structuredClone(fixture);
  input.scheduledEvents = [{ afterUtterance: 6, text: '초인종이 울린다.' }];
  const original = structuredClone(input);
  const { specs, expectedCalls } = prepareConversations([input, input], options);
  assert.deepEqual(input, original);
  assert.equal(expectedCalls, 288);
  for (const spec of specs) {
    assert.equal(spec.scenario.worldEngineInstructions, input.scenario.worldEngineInstructions);
    assert.deepEqual(spec.scenario.characters, input.scenario.characters);
    assert.equal(spec.scheduledEvents[0].text, '초인종이 울린다.');
    assert.deepEqual(spec.worldEngine, { model: 'mock-world', effort: 'medium' });
    assert.equal(spec.repetitions, 2);
    assert.ok(spec.variants.every(v => v.environmentMode === 'ai' && v.turnPolicy === 'round_robin'));
    const [a, b] = spec.variants.map(v => ({ ...v, id: '', label: '', dialoguePromptVersion: '' }));
    assert.deepEqual(a, b);
  }
  assert.deepEqual(specs[0].variants.map(v => v.dialoguePromptVersion), [options.baseline, options.candidate]);
  assert.deepEqual(specs[1].variants.map(v => v.dialoguePromptVersion), [options.candidate, options.baseline]);
  input.variants[0].environmentMode = 'off';
  assert.equal(prepareConversations([input], options).expectedCalls, 72);
});

test('world comparisons fix NPC instructions and vary only the world policy', () => {
  const selected = { ...options, baseline: options.candidate, worldBaseline: 'npc-world/2' as const, worldCandidate: 'npc-world/4' as const };
  const { specs: [spec], expectedCalls } = prepareConversations([fixture], selected);
  assert.equal(expectedCalls, 144);
  assert.ok(spec.variants.every(v => v.dialoguePromptVersion === 'npc-dialogue/5'));
  assert.deepEqual(spec.variants.map(v => v.worldPromptVersion), ['npc-world/2', 'npc-world/4']);
  assert.throws(() => prepareConversations([fixture], { ...selected, baseline: 'npc-dialogue/3' }), /one fixed NPC policy/);
  const off = structuredClone(fixture); off.variants[0].environmentMode = 'off';
  assert.throws(() => prepareConversations([off], selected), /AI mode/);
});
