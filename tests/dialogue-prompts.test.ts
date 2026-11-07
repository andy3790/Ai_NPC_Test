import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dialoguePolicies } from '../src/core/dialogue-policies.js';
import { CURRENT_DIALOGUE_PROMPT, DIALOGUE_PROMPT_VERSIONS } from '../src/shared/dialogue-policy.js';
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
    'npc-dialogue/4': 'e1531cc297bb7d5f2b5354985790de335ebdea7b6190b0a0f866079f938c33df',
    'npc-dialogue/5': '15e5ca0e0d2ac96868cfcd2b6c44e8972a828b6e6464b1e483f351da3fc3f8b5',
    'npc-dialogue/6': 'dd4b5ea4c4d22bd1f94b195278e92c94ba4d0e75b908504e25dbf0876aca5bc8',
    'npc-dialogue/7': 'dd4b5ea4c4d22bd1f94b195278e92c94ba4d0e75b908504e25dbf0876aca5bc8',
    'npc-dialogue/8': '2ea1bd820ae7ba27d7b12df20abd274930c576e356dee553e97ef6c1d77bd4d4',
    'npc-dialogue/9': 'dd4b5ea4c4d22bd1f94b195278e92c94ba4d0e75b908504e25dbf0876aca5bc8',
    'npc-dialogue/10': '8db1181b42e7360cd0badfa25ff227ddf1a399321e05d6f6d95e1e2633fcf871',
  };
  assert.deepEqual(Object.keys(expected), [...DIALOGUE_PROMPT_VERSIONS]);
  assert.ok(dialoguePolicies['npc-dialogue/10'].instructions.startsWith(dialoguePolicies['npc-dialogue/5'].instructions + '\n'));
  // Effective /5 persona recorded before the /7+ layout branch was introduced.
  assert.equal(caseInput(suite.cases[0], 'npc-dialogue/5', 'mock-model', 'low').instructionsSha256,
    '29be3ddda6c686819a596cd0470f7d26cc2582d6e396e1371f41f0bb63ad5e59');
  assert.equal(sha256(dialoguePolicies['npc-dialogue/9'].voiceInstruction),
    'c34a1cce16729561dd14ce0ecb31e77808ed3766bf2336b7ecba1ad5379a6ab2');
  assert.equal(caseInput(suite.cases[0], 'npc-dialogue/9', 'mock-model', 'low').instructionsSha256,
    '0a34c67f606e13c873b31fbd7665083d918d4496787d559f39f613b13fb1c865');
  assert.deepEqual(Object.entries(dialoguePolicies).filter(([, p]) => 'profilePlacement' in p).map(([version, p]) =>
    [version, 'profilePlacement' in p ? p.profilePlacement : null]), [['npc-dialogue/7', 'after_rules'], ['npc-dialogue/8', 'after_rules'], ['npc-dialogue/9', 'after_rules']]);
  for (const [version, hash] of Object.entries(expected)) {
    assert.equal(sha256(dialoguePolicies[version as keyof typeof dialoguePolicies].instructions), hash,
      'Add a new policy revision; do not rewrite the baseline/candidate that generated recorded samples.');
  }
});

test('policy comparisons hold the full observed input constant and exclude review/private material', () => {
  const cases = ['cases.json', 'continuity-cases.json', 'continuity-transfer.json', 'follow-through-cases.json', 'voice-contrast.json', 'voice-transfer.json'].flatMap(file =>
    dialogueCasesSchema.parse(JSON.parse(readFileSync(new URL('../evals/dialogue/' + file, import.meta.url), 'utf8'))).cases);
  for (const source of cases) {
    const c = structuredClone(source);
    c.characters.find(a => a.id !== c.speakerId)!.memories += ' PRIVATE_OTHER_PERSON';
    c.review.push('REVIEW_ONLY_NEVER_SEND');
    const baseline = caseInput(c, 'npc-dialogue/1', 'mock-model', 'low');
    for (const version of DIALOGUE_PROMPT_VERSIONS) {
      const candidate = caseInput(c, version, 'mock-model', 'low');
      assert.equal(candidate.input, baseline.input);
      let text = candidate.instructions.replace(dialoguePolicies[version].instructions, '<policy>');
      const original = baseline.instructions.replace(dialoguePolicies['npc-dialogue/1'].instructions, '<policy>');
      if (version === 'npc-dialogue/9') {
        const actor = c.characters.find(a => a.id === c.speakerId)!;
        const voice = [['말하는 방식', actor.speechStyle], ['말투 예시', actor.exampleDialogue]]
          .filter(([, value]) => value?.trim()).map(([label, value]) => `${label}: ${value}`).join('\n\n');
        const suffix = '\n\n이번 인물의 발화 기준:\n' + dialoguePolicies[version].voiceInstruction + '\n\n' + voice;
        assert.ok(text.endsWith(suffix));
        text = text.slice(0, -suffix.length);
        const after = ['몸에 밴 행동', '개인적인 금기'].find(label => text.includes('\n\n' + label + ':'));
        if (voice) text = after ? text.replace('\n\n' + after + ':', '\n\n' + voice + '\n\n' + after + ':') : text + '\n\n' + voice;
      }
      if (['npc-dialogue/7', 'npc-dialogue/8', 'npc-dialogue/9'].includes(version)) {
        // /7+ preserves the profile while moving it after the common rules. The complete original profile still occurs
        // exactly once, with all world/authority/output instructions unchanged.
        const marker = '\n\n이번 역할의 인물 기준:\n';
        const split = text.indexOf(marker); assert.ok(split > 0);
        const profile = text.slice(split + marker.length);
        assert.ok(original.includes('\n\n' + profile + '\n\n함께 아는 배경:'));
        text = text.slice(0, split).replace('\n\n함께 아는 배경:', '\n\n' + profile + '\n\n함께 아는 배경:');
      }
      assert.equal(text, original);
      assert.doesNotMatch(candidate.instructions + candidate.input, /PRIVATE_OTHER_PERSON|REVIEW_ONLY_NEVER_SEND/);
    }
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
    const variant = { ...run.variant }; delete variant.dialoguePromptVersion; delete variant.characterPerformanceVersion;
    store.patch('runs', run.id, { variant, promptVersion: 'npc-lab/5' });
    await engine.resume(run.id, true); await engine.idle();
    const before = structuredClone(engine.run(run.id).sessions);
    assert.ok(Object.values(before).every(s => s.instructions.includes(dialoguePolicies['npc-dialogue/1'].instructions)));
    await engine.resume(run.id); await engine.idle();
    const d = engine.detail(run.id);
    assert.deepEqual(d.run.sessions, before);
    assert.ok(Object.values(d.run.sessions).every(s => s.performance === undefined));
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
  for (const dialoguePromptVersion of DIALOGUE_PROMPT_VERSIONS) {
    const prompt = persona(spec, spec.scenario.characters[0], { ...spec.variants[0], environmentMode: 'ai', dialoguePromptVersion });
    assert.match(prompt, /OWN_PRIVATE/);
    assert.doesNotMatch(prompt, /OTHER_PRIVATE|ENGINE_PRIVATE/);
    assert.match(prompt, /세계 엔진의 공개 결과를 기다리며 먼저 성공을 단정하지/);
  }
});
