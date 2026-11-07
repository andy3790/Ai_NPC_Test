import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { experimentSchema, characterSchema } from '../src/shared/schema.js';
import { persona, evaluationPrompt } from '../src/core/prompts.js';
import { worldPrompt, initialWorldState, applyWorldOutput } from '../src/core/world.js';
import { directorPrompt } from '../src/core/director.js';
import { managerWorld } from '../src/core/spatial-prompts.js';
import { apiRoleDefaults } from '../src/shared/role-models.js';
import type { Utterance } from '../src/shared/types.js';
import type { WorldOutput } from '../src/shared/world-schema.js';

const root = new URL('../assets/seowol/', import.meta.url);
const read = (file: string) => readFileSync(new URL(file, root), 'utf8');
const delivery = experimentSchema.parse(JSON.parse(read('experiments/return-deadline.json')));
const quiet = experimentSchema.parse(JSON.parse(read('experiments/maintenance-talk.json')));
const canon = read('02_이면기록_서월_캐릭터챗_운영팩_v1.1.md');

test('all six dramatic presets inherit the selected NPC and keep world and speaker selection independent', () => {
  const { scenes } = JSON.parse(read('drama/manifest.json')) as { scenes: { file: string }[] };
  assert.equal(scenes.length, 6);
  for (const { file } of scenes) {
    const spec = experimentSchema.parse(JSON.parse(read('drama/' + file)));
    assert.deepEqual(spec.scenario.defaults, apiRoleDefaults.npc, file);
    assert.deepEqual(spec.worldEngine, apiRoleDefaults.worldEngine, file);
    assert.deepEqual(spec.director, apiRoleDefaults.director, file);
    assert.ok([...spec.variants, ...spec.scenario.characters].every(v => v.model === undefined && v.effort === undefined), file);
    assert.ok(spec.variants.every(v => !v.eventGeneration), file);
    assert.equal(spec.evaluation.enabled, false, file);
  }
});

test('closing-door v2 shares the photograph and narrowing gap while keeping recognition and deadlines in their roles', () => {
  const spec = experimentSchema.parse(JSON.parse(read('experiments/drama-closing-door.json')));
  const { scenario } = spec;
  const manifest = JSON.parse(read('drama/manifest.json')) as { scenes: { file: string; id: string }[] };
  assert.equal(scenario.id, 'seowol_drama_closing_door_v2');
  assert.equal(manifest.scenes.find(s => s.file.endsWith('/drama-closing-door.json'))?.id, scenario.id);
  const director = directorPrompt({ characters: scenario.characters, allowedSpeakerIds: scenario.characters.map(c => c.id),
    history: [], speeches: [], initialScene: scenario.situation });
  const world = managerWorld(spec);
  const participants = scenario.characters.map(c => ({ id: c.id, input: persona(spec, c, spec.variants[0]) }));
  for (const { id, input } of [...participants, { id: 'director', input: director.input }]) {
    assert.ok(input.includes('해경 네 살'), id);
    assert.ok(input.includes('손가락 두 개'), id);
    assert.equal(input.includes('시장 앞'), id === 'yoon_haegyeong', id);
    assert.doesNotMatch(input, /8초 눈금 소실|24초 문 폐쇄/);
  }
  assert.equal(world.situation, scenario.situation);
  assert.match(world.worldEngineInstructions, /8초 눈금 소실과 24초 문 폐쇄/);
  assert.doesNotMatch(JSON.stringify(world), /시장 앞/);
});

test('Seowol actors retain authored identities, abilities, limitations and private histories', () => {
  for (const id of ['cha_yujin', 'jang_serim', 'ryu_taekyung', 'lee_harin', 'na_yeonwoo']) {
    const c = characterSchema.parse(JSON.parse(read(`characters/${id}.json`)));
    const section = canon.split(new RegExp(`### 5-\\d+\\. ${c.name}\\r?\\n`))[1].split('### ')[0];
    for (const [label, destination] of [
      ['기본', c.identity], ['이능과 한계', c.behaviors], ['인지 차폐', c.behaviors],
      ['실제 지식', c.knowledge], ['비공개', c.memories], ['결함과 그 피해', c.personality],
    ]) {
      const line = section.split(/\r?\n/).find(line => line.startsWith(`${label}:`))!;
      const fact = line.slice(label.length + 1).trim();
      assert.ok(fact.length > 10, `${c.name}: missing source ${label}`);
      assert.ok(destination!.includes(fact), `${c.name}: changed canon ${label}`);
    }
    // Future character arcs are author options, not an imperative to become
    // considerate, reconcile or disclose secrets during the next few turns.
    assert.doesNotMatch(JSON.stringify(c), /가능한 변화:|\{\{user\}\}|[\u3040-\u30ff]/u);
  }
});

test('Seowol scene truth and other actors private facts do not leak into NPC/director prompts', () => {
  const spec = structuredClone(delivery);
  spec.scenario.worldEngineInstructions += '\nENGINE_ONLY_CONTACT_FAULT';
  spec.scenario.characters[1].memories += '\nSERIM_PRIVATE_APPROVAL';
  const actor = persona(spec, spec.scenario.characters[0], spec.variants[0]);
  assert.doesNotMatch(actor, /ENGINE_ONLY_CONTACT_FAULT|SERIM_PRIVATE_APPROVAL/);
  const source = { id: 's1', sequence: 1, speechIndex: 1, kind: 'speech', speakerId: 'cha_yujin',
    speakerName: '차유진', speech: '잠깐요.', action: '' } as Utterance;
  const world = worldPrompt(spec, initialWorldState(), [source], source);
  assert.match(world, /ENGINE_ONLY_CONTACT_FAULT/);
  assert.doesNotMatch(world, /SERIM_PRIVATE_APPROVAL/);
  const director = directorPrompt({ characters: spec.scenario.characters, allowedSpeakerIds: ['jang_serim'], history: [source], speeches: [source] });
  assert.doesNotMatch(director.input, /ENGINE_ONLY_CONTACT_FAULT|SERIM_PRIVATE_APPROVAL/);
  const judge = JSON.parse(evaluationPrompt(spec, [source], [source], spec.variants[0]).input);
  assert.match(judge.worldEngineInstructions, /ENGINE_ONLY_CONTACT_FAULT/);
  assert.match(judge.characterJudgmentPolicy, /NPC 공통 지식이 아니/);
});

test('Seowol control scene preserves the original situation and can be compared separately', () => {
  const original = experimentSchema.parse(JSON.parse(read('seowol_maintenance_talk_v11_engine.json')));
  assert.equal(quiet.scenario.situation, original.scenario.situation);
  assert.deepEqual(quiet.scenario.characters.map(c => c.id), original.scenario.characters.map(c => c.id));
  assert.deepEqual(delivery.scenario.characters.map(c => c.id), ['cha_yujin', 'jang_serim', 'ryu_taekyung']);
  for (const spec of [delivery, quiet]) {
    assert.equal(spec.evaluation.enabled, false);
    assert.equal(spec.variants[0].eventGeneration, false);
    assert.equal(spec.variants[0].environmentMode, 'ai');
  }
  const sol = experimentSchema.parse(JSON.parse(read('experiments/return-deadline-sol.json')));
  assert.equal(sol.variants[0].model, 'gpt-6.1-sol');
  sol.name = delivery.name;
  sol.scenario.defaults = delivery.scenario.defaults;
  sol.variants[0].model = delivery.variants[0].model;
  sol.variants[0].label = delivery.variants[0].label;
  assert.deepEqual(sol, delivery, 'model comparison must keep scene, profiles, helpers and run limits fixed');
});

test('object movement must not be mislabeled as an NPC physical effect; valid action results commit once', () => {
  // Reproduces the first real API trial's null-npc physical_effect failure.
  const source = { id: 's1', sequence: 1, speechIndex: 1, kind: 'speech', speakerId: 'cha_yujin',
    speakerName: '차유진', speech: '잡아 줘요.', action: '고무 쐐기를 바퀴 아래에 끼우려 한다.' } as Utterance;
  const output: WorldOutput = { elapsedSeconds: 2, facts: [{ id: 'wheel', text: '대차가 멈췄다.', scope: 'environment', npcId: null }],
    forgetFactIds: [], processes: [], finishProcesses: [], events: [
      { type: 'physical_effect', text: '대차 바퀴가 멎었다.', npcId: null, evidence: null, processId: null },
    ] };
  const state = initialWorldState();
  assert.throws(() => applyWorldOutput(state, output, source, ['cha_yujin']), /신체적 결과의 대상 NPC/);
  assert.deepEqual(state, initialWorldState());
  output.events[0] = { ...output.events[0], type: 'actor_result', npcId: source.speakerId, evidence: source.action };
  const result = applyWorldOutput(state, output, source, ['cha_yujin']);
  assert.equal(result.state.virtualSeconds, 2);
  assert.equal(result.state.facts[0].text, '대차가 멈췄다.');
  assert.equal(result.output.events.length, 1);
  const speechOnly = { ...source, id: 's2', sequence: 3, speechIndex: 2, speech: '그 돈은 못 내요.', action: '' };
  const silent = applyWorldOutput(result.state, { ...output, elapsedSeconds: 3, facts: [], events: [] }, speechOnly, ['cha_yujin']);
  assert.equal(silent.output.events.length, 0);
  assert.deepEqual(silent.state.facts, result.state.facts);
  assert.equal(silent.state.processedSpeechCount, 2);
});

test('successful booking before a deadline cancels the timeout instead of completing it early', () => {
  const source = { id: 'booking', sequence: 3, speechIndex: 2, kind: 'speech', speakerId: 'jang_serim',
    speakerName: '장세림', speech: '', action: '태블릿으로 반송 접수를 보낸다.' } as Utterance;
  const state = initialWorldState(); state.virtualSeconds = 10;
  state.processes.push({ id: 'return_deadline', description: '미접수 상태의 반송 접수 마감', readyAtSeconds: 120,
    createdAtSeconds: 0, sourceUtteranceId: 'start', waitingNpcIds: [], offeredNpcIds: [], status: 'pending', finishedAtSeconds: null, reason: null });
  const output: WorldOutput = { elapsedSeconds: 3, facts: [], forgetFactIds: [], processes: [],
    finishProcesses: [{ id: 'return_deadline', outcome: 'completed', reason: '접수 성공' }],
    events: [{ type: 'external_signal', text: '태블릿에 접수 완료 화면이 뜬다.', npcId: null, evidence: null, processId: 'return_deadline' }] };
  assert.throws(() => applyWorldOutput(state, output, source, ['jang_serim']), /현재 13초.*120초.*cancelled/);
  assert.equal(state.processes[0].status, 'pending');
  output.finishProcesses[0].outcome = 'cancelled';
  const result = applyWorldOutput(state, output, source, ['jang_serim']);
  assert.equal(result.state.virtualSeconds, 13);
  assert.equal(result.state.processes[0].status, 'cancelled');
  assert.equal(result.output.events[0].text, '태블릿에 접수 완료 화면이 뜬다.');
});
