import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dialoguePolicies } from '../src/core/dialogue-policies.js';
import { CURRENT_DIALOGUE_PROMPT } from '../src/shared/dialogue-policy.js';
import { persona, PROMPT_VERSION } from '../src/core/prompts.js';
import { exampleSpec } from '../src/shared/example.js';
import { experimentSchema } from '../src/shared/schema.js';
import { Engine } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
import { MockAdapter } from '../src/adapters/mock.js';
import { caseInput, dialogueCasesSchema, policyOrder, renderReview, sha256 } from '../scripts/lib/dialogue-eval.js';

const suite = dialogueCasesSchema.parse(JSON.parse(readFileSync(new URL('../evals/dialogue/cases.json', import.meta.url), 'utf8')));

test('published dialogue policy texts cannot drift silently under an existing version', () => {
  const expected = {
    'npc-dialogue/1': '9e5b7796eeb9a79fae4e1be1d9d4431e7abc72a74743a97ca6c6693790f1d577',
    'npc-dialogue/2': 'e8192591ec62b0d6e52fb268e8a0ae8116744b1ad8238af06794c09728ce40e2',
    'npc-dialogue/3': 'c8204210b3c3da1779d6556a994fa03fd6e1a81613fb52dffa2f323f7b2c7aae',
  };
  for (const [version, hash] of Object.entries(expected)) {
    assert.equal(sha256(dialoguePolicies[version as keyof typeof dialoguePolicies].instructions), hash,
      'Add a new policy revision; do not rewrite the baseline/candidate that generated recorded samples.');
  }
});

test('policy comparisons hold the full observed input constant and exclude review/private material', () => {
  for (const source of suite.cases) {
    const c = structuredClone(source);
    c.characters.find(a => a.id !== c.speakerId)!.memories += ' PRIVATE_OTHER_PERSON';
    c.review.push('REVIEW_ONLY_NEVER_SEND');
    const a = caseInput(c, 'npc-dialogue/1', 'mock-model', 'low');
    const b = caseInput(c, 'npc-dialogue/2', 'mock-model', 'low');
    assert.equal(a.input, b.input);
    assert.equal(a.instructions.replace(dialoguePolicies['npc-dialogue/1'].instructions, '<policy>'),
      b.instructions.replace(dialoguePolicies['npc-dialogue/2'].instructions, '<policy>'));
    for (const p of [a, b]) assert.doesNotMatch(p.instructions + p.input, /PRIVATE_OTHER_PERSON|REVIEW_ONLY_NEVER_SEND/);
    const latest = caseInput(c, 'npc-dialogue/3', 'mock-model', 'low');
    assert.equal(a.input, latest.input);
    assert.doesNotMatch(latest.instructions + latest.input, /PRIVATE_OTHER_PERSON|REVIEW_ONLY_NEVER_SEND/);
  }
  assert.ok(suite.cases.some(c => c.split === 'holdout'));
  assert.notDeepEqual(policyOrder(0, 1), policyOrder(0, 2));
  const review = renderReview(suite.cases.slice(0, 1), [{ caseId: suite.cases[0].id, repetition: 1, slot: 'A', status: 'completed', output: '{"speech":"원문"}' }]);
  assert.match(review, /원문/);
  assert.doesNotMatch(review, /npc-dialogue\/[12]/);
});

test('unknown policy revisions are rejected instead of silently falling back', () => {
  const spec = exampleSpec('mock-model');
  assert.equal(experimentSchema.safeParse({ ...spec, variants: [{ ...spec.variants[0], dialoguePromptVersion: 'npc-dialogue/999' }] }).success, false);
});

test('paused runs pin policy selection and preserve the source spec; calls keep provenance', async () => {
  const store = new Store(':memory:'), adapter = new MockAdapter(), engine = new Engine(store, adapter, '.cache/dialogue-tests');
  const spec = exampleSpec('mock-model'); spec.maxUtterances = 1; spec.evaluation.enabled = false;
  delete spec.scenario.environment;
  spec.variants = [{ ...spec.variants[0], id: 'old', dialoguePromptVersion: 'npc-dialogue/1' }, { ...spec.variants[0], id: 'new' }];
  try {
    const { runs } = await engine.create(spec, false);
    assert.equal(runs[0].variant.dialoguePromptVersion, 'npc-dialogue/1');
    assert.equal(runs[1].variant.dialoguePromptVersion, CURRENT_DIALOGUE_PROMPT);
    assert.equal(runs[1].spec.variants[1].dialoguePromptVersion, undefined);
    assert.notEqual(runs[0].snapshotHash, runs[1].snapshotHash);
    for (const run of runs) {
      await engine.resume(run.id); await engine.idle();
      const d = engine.detail(run.id);
      assert.equal(d.run.status, 'completed');
      for (const session of Object.values(d.run.sessions)) assert.ok(session.instructions.includes(dialoguePolicies[run.variant.dialoguePromptVersion!].instructions));
      for (const call of d.invocations) {
        assert.equal(call.metadata.dialoguePromptVersion, run.variant.dialoguePromptVersion);
        assert.equal(call.metadata.promptVersion, run.promptVersion);
        assert.equal(call.metadata.runtimePromptVersion, PROMPT_VERSION);
        assert.equal(call.metadata.instructionsSha256, sha256(d.run.sessions[call.characterId!].instructions));
      }
    }
  } finally { await engine.close(); store.close(); }
});

test('old runs retain stored personas and are not relabeled as the current prompt on resume', async () => {
  const store = new Store(':memory:'), adapter = new MockAdapter(), engine = new Engine(store, adapter, '.cache/dialogue-tests');
  const spec = exampleSpec('mock-model'); spec.maxUtterances = 2; spec.evaluation.enabled = false;
  delete spec.scenario.environment; spec.variants = [spec.variants[0]];
  try {
    const { runs } = await engine.create(spec, false), run = runs[0];
    const variant = { ...run.variant }; delete variant.dialoguePromptVersion;
    store.patch('runs', run.id, { variant, promptVersion: 'npc-lab/5' });
    await engine.resume(run.id, true); await engine.idle();
    const before = structuredClone(engine.run(run.id).sessions);
    assert.ok(Object.values(before).every(s => s.instructions.includes(dialoguePolicies['npc-dialogue/1'].instructions)));
    await engine.resume(run.id); await engine.idle();
    const d = engine.detail(run.id);
    assert.deepEqual(d.run.sessions, before);
    assert.equal(d.run.status, 'completed');
    assert.ok(d.invocations.every(c => c.metadata.promptVersion === 'npc-lab/5' && c.metadata.dialoguePromptVersion === null));
    assert.equal(d.run.variant.dialoguePromptVersion, undefined);
  } finally { await engine.close(); store.close(); }
});

test('all policies keep private information and outcome authority boundaries', () => {
  const spec = exampleSpec('mock-model');
  spec.scenario.characters[0].memories += ' OWN_PRIVATE';
  spec.scenario.characters[1].memories += ' OTHER_PRIVATE';
  spec.scenario.worldEngineInstructions = 'ENGINE_PRIVATE';
  for (const dialoguePromptVersion of ['npc-dialogue/1', 'npc-dialogue/2', 'npc-dialogue/3'] as const) {
    const prompt = persona(spec, spec.scenario.characters[0], { ...spec.variants[0], environmentMode: 'ai', dialoguePromptVersion });
    assert.match(prompt, /OWN_PRIVATE/);
    assert.doesNotMatch(prompt, /OTHER_PRIVATE|ENGINE_PRIVATE/);
    assert.match(prompt, /세계 엔진의 공개 결과를 기다리며 먼저 성공을 단정하지/);
  }
});
