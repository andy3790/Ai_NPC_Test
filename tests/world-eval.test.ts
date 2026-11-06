import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inspectWorldResponse, worldCasesSchema } from '../scripts/lib/world-eval.js';
const suite = worldCasesSchema.parse(JSON.parse(readFileSync(new URL('../evals/world/observations.json', import.meta.url), 'utf8')));
const empty = { elapsedSeconds: 1, facts: [], forgetFactIds: [], processes: [], finishProcesses: [], events: [] };

test('world fixtures preserve observed inputs and keep scoring material outside the model request', () => {
  assert.ok(suite.cases.some(c => c.split === 'holdout'));
  for (const c of suite.cases) {
    const input = JSON.parse(c.input);
    assert.equal(input.review, undefined); assert.equal(input.eventExpectation, undefined);
    for (const npc of input.npcs) assert.deepEqual(Object.keys(npc).sort(), ['id', 'name']);
  }
});

test('a quiet output can pass structure and still fail a required-disclosure case', () => {
  const quiet = suite.cases.find(c => c.id === 'ordinary_glance')!, needed = suite.cases.find(c => c.id === 'charging_result')!;
  assert.equal(inspectWorldResponse(quiet, JSON.stringify(empty)).eventExpectationMet, true);
  const result = inspectWorldResponse(needed, JSON.stringify(empty));
  assert.equal(result.valid, true); assert.equal(result.eventExpectationMet, false);
});

test('replay checks retain the runtime rejection of incompatible fact updates', () => {
  const c = suite.cases.find(c => c.id === 'seowol_step_back')!;
  const input = JSON.parse(c.input), fact = input.state.facts[0];
  assert.ok(fact);
  const result = inspectWorldResponse(c, JSON.stringify({ ...empty, facts: [fact], forgetFactIds: [fact.id] }));
  assert.equal(result.valid, false); assert.match(result.error!, /동시에 제거·변경/);
});
