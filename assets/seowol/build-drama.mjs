import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import roleDefaults from '../../src/config/role-defaults.json' with { type: 'json' };
import { canonVoices, newCast } from './drama/cast.mjs';
import { commonWorld, commonEngineNotes, scenes } from './drama/scenes.mjs';

const ownRoot = dirname(fileURLToPath(import.meta.url));
const fields = ['기본', '표면 생활', '외모와 습관', '이능과 한계', '인지 차폐', '실제 지식', '욕망과 당장의 목표', '결함과 그 피해', '지키려는 선', '비공개', '비밀의 공개 계기', '관계'];

function readCard(source, name) {
  const section = source.split(new RegExp(`### 5-\\d+\\. ${name}\\r?\\n`))[1]?.split('### ')[0];
  const body = section?.split('```text')[1]?.split('```')[0];
  if (!body) throw new Error(`Missing canon card: ${name}`);
  const result = Object.fromEntries(body.trim().split(/\r?\n/).filter(line => line.includes(':')).map(line => {
    const colon = line.indexOf(':');
    return [line.slice(0, colon), line.slice(colon + 1).trim()];
  }));
  for (const key of fields) if (!result[key]) throw new Error(`Missing canon field: ${name} / ${key}`);
  return result;
}

function canonCharacter(id, voice, c, guidance) {
  return {
    id, name: voice.name, identity: `${c['기본']}\n${c['표면 생활']}`,
    personality: c['결함과 그 피해'], values: c['지키려는 선'], goals: c['욕망과 당장의 목표'],
    relationships: c['관계'], memories: `${c['비공개']}\n공개 계기: ${c['비밀의 공개 계기']}`,
    knowledge: c['실제 지식'], unknowns: '타인의 비공개 기억·목표와 아직 보거나 듣지 않은 사건의 진상은 모른다.',
    speechStyle: `${guidance}\n\n${voice.speechStyle}`, exampleDialogue: voice.exampleDialogue,
    behaviors: `${c['외모와 습관']}\n이능과 한계: ${c['이능과 한계']}\n인지 차폐: ${c['인지 차폐']}`, taboos: '',
  };
}

export async function buildDramaticScenes(root = ownRoot) {
  const [cards, worldCanon, original, interaction] = await Promise.all([
    readFile(join(root, '02_이면기록_서월_캐릭터챗_운영팩_v1.1.md'), 'utf8'),
    readFile(join(root, '01_이면기록_서월_세계관설정집_v1.1.md'), 'utf8'),
    readFile(join(root, 'seowol_maintenance_talk_v11_engine.json'), 'utf8').then(JSON.parse),
    readFile(join(root, 'interaction.json'), 'utf8').then(JSON.parse),
  ]);
  if (!interaction.guidance?.trim()) throw new Error('Missing interaction guidance');
  const characters = {}, capabilities = {}, extraProfiles = [];
  const existingIds = ['cha_yujin', 'jang_serim', 'ryu_taekyung', 'lee_harin', 'na_yeonwoo'];
  for (const id of existingIds) {
    const c = JSON.parse(await readFile(join(root, 'characters', `${id}.json`), 'utf8'));
    const card = readCard(cards, c.name);
    characters[id] = c;
    capabilities[id] = `${card['이능과 한계']}\n인지 차폐: ${card['인지 차폐']}`;
  }
  for (const [id, voice] of Object.entries(canonVoices)) {
    const card = readCard(cards, voice.name);
    characters[id] = canonCharacter(id, voice, card, interaction.guidance);
    capabilities[id] = `${card['이능과 한계']}\n인지 차폐: ${card['인지 차폐']}`;
    extraProfiles.push(id);
  }
  for (const raw of newCast) {
    const { ability, shield, ...c } = raw;
    if (characters[c.id]) throw new Error(`Duplicate character: ${c.id}`);
    characters[c.id] = {
      ...c, speechStyle: `${interaction.guidance}\n\n${c.speechStyle}`,
      behaviors: `${c.behaviors}\n이능과 한계: ${ability}\n인지 차폐: ${shield}`,
      taboos: '새로운 능력·과거·동의·행동의 성공 결과를 스스로 추가하지 않는다. 본인의 말투 예시는 실제 사건이나 타인의 반응이 아니다.',
    };
    capabilities[c.id] = `${ability}\n인지 차폐: ${shield}`;
    extraProfiles.push(c.id);
  }
  const eventIds = { 'closing-door': 'A', 'last-platform': 'C', 'warehouse-twelve': 'E', 'third-call': 'D', 'return-current': 'B' };
  const outputs = [];
  const slugs = new Set();
  for (const scene of scenes) {
    if (slugs.has(scene.slug)) throw new Error(`Duplicate scene: ${scene.slug}`);
    slugs.add(scene.slug);
    const cast = scene.participants.map(({ id, ...overrides }) => {
      if (!characters[id]) throw new Error(`Unknown actor: ${scene.slug} / ${id}`);
      const c = structuredClone(characters[id]);
      for (const [field, addition] of Object.entries(overrides)) {
        if (!['goals', 'knowledge', 'memories', 'relationships', 'unknowns'].includes(field)) throw new Error(`Invalid scene overlay: ${field}`);
        c[field] = `${c[field]}\n\n이번 장면: ${addition}`;
      }
      return c;
    });
    const eventId = eventIds[scene.slug];
    const eventCanon = eventId ? worldCanon.split(`### 사건 ${eventId} `)[1]?.split('### ')[0].trim() : '';
    if (eventId && !eventCanon) throw new Error(`Missing canon event: ${eventId}`);
    const mode = scene.spatial ? 'ai_spatial' : 'ai';
    // Build fresh: the original everyday experiment forbids the very incidents
    // this separate pack is meant to explore. Never inherit its event generator.
    const spec = {
      schemaVersion: 1, name: `서월 사건극 — ${scene.title}`,
      scenario: {
        id: `seowol_drama_${scene.slug.replaceAll('-', '_')}_v${scene.revision ?? 1}`, name: scene.title,
        world: commonWorld, situation: scene.opening, characters: cast,
        defaults: roleDefaults.npc,
        worldEngineInstructions: [
          '세계 정사 기준 — 판정 전용. NPC 공통 지식으로 통째로 전달하지 않는다.', original.scenario.world,
          eventCanon ? `원작 사건의 고정 조건:\n${eventCanon}` : '',
          '이번 참가자의 판정용 능력·차폐 조건:', ...cast.map(c => `${c.name}: ${capabilities[c.id]}`),
          '진행 원칙:', commonEngineNotes,
          '이번 장면에만 적용되는 원인·단서·시간·결과:', ...scene.engineRules.map((rule, i) => `${i + 1}. ${rule}`),
        ].filter(Boolean).join('\n\n'),
        ...(scene.spatial ? { spatial: scene.spatial } : {}),
        clockEvents: scene.clockEvents,
      },
      variants: [{ id: 'drama', label: scene.spatial ? '분산 공간' : '단일 현장',
        dialoguePromptVersion: 'npc-dialogue/5',
        ...(scene.spatial ? {} : { worldPromptVersion: 'npc-world/6' }),
        memoryMode: 'initial_only', deliveryMode: 'batched_on_turn', turnPolicy: 'director',
        environmentMode: mode, eventGeneration: false,
      }],
      repetitions: 1, maxUtterances: scene.turns, concurrentRuns: 1, maxConcurrentCalls: 2, timeoutMs: 300000,
      evaluation: { enabled: false, interval: 12, model: 'gpt-6-luna', effort: 'low', contextCharacters: 100000, repetitionWindow: 12, repetitionThreshold: 0.72, repetitionMinChars: 20 },
      director: roleDefaults.director, worldEngine: roleDefaults.worldEngine,
      scheduledEvents: [],
    };
    outputs.push({ scene, spec, filename: `drama-${scene.slug}.json` });
  }
  // Resolve and check every scene before writing any generated output.
  await mkdir(join(root, 'drama', 'characters'), { recursive: true });
  await mkdir(join(root, 'experiments'), { recursive: true });
  const writeJson = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');
  for (const id of extraProfiles) await writeJson(join(root, 'drama', 'characters', `${id}.json`), characters[id]);
  for (const { spec, filename } of outputs) await writeJson(join(root, 'experiments', filename), spec);
  const manifest = {
    version: 2, scope: '독립 에피소드용 추가안. 기존 정사와 별도 세션의 결과를 덮어쓰지 않는다.',
    canonCharacterIds: [...existingIds, ...Object.keys(canonVoices)], newCharacterIds: newCast.map(c => c.id),
    scenes: outputs.map(({ scene, spec, filename }) => ({
      id: spec.scenario.id, title: scene.title, file: `../experiments/${filename}`,
      genre: scene.genre, mode: spec.variants[0].environmentMode, maxUtterances: spec.maxUtterances,
      characters: spec.scenario.characters.map(c => ({ id: c.id, name: c.name })), canon: scene.canon, additions: scene.additions,
      revision: scene.revision, spatial: scene.spatial ?? null, clockEvents: scene.clockEvents,
    })),
  };
  await writeJson(join(root, 'drama', 'manifest.json'), manifest);
  await writeFile(join(root, 'drama', 'README.md'), guide(outputs), 'utf8');
  console.log(`SEOWOL_DRAMA_BUILD_OK: ${outputs.length} scenes, ${newCast.length} new characters, ${Object.keys(canonVoices).length} additional canon profiles.`);
  return outputs.map(o => o.spec);
}

function guide(outputs) {
  const sections = outputs.map(({ scene, filename, spec }, i) => [
    `## ${i + 1}. ${scene.title}`, '', scene.pitch, '',
    ...(scene.revision ? [`장면 v${scene.revision} · [변경 이력](../../../CHANGELOG.md)`, ''] : []),
    `**장르:** ${scene.genre}  `,
    `**참가자:** ${spec.scenario.characters.map(c => c.name).join('·')}  `,
    `**실행:** [${filename}](../experiments/${filename}) · ${scene.spatial ? '분산 공간' : '단일 현장'} · 최대 ${scene.turns}차례`, '',
    '### 시작 장면', '', scene.opening, '',
    '### 현장 배치와 전달', '',
    ...(scene.spatial ? [
      ...scene.spatial.locations.map(l => {
        const names = scene.spatial.initialPositions.filter(p => p.locationId === l.id).map(p => spec.scenario.characters.find(c => c.id === p.npcId).name);
        return `- **${l.name}** (${names.join('·') || '시작 인원 없음'}) — ${l.initialSituation}`;
      }), '',
      ...scene.spatial.connections.map(r => `- ${scene.spatial.locations.find(l => l.id === r.from).name} ${r.bidirectional ? '↔' : '→'} ${scene.spatial.locations.find(l => l.id === r.to).name} · ${r.description}`), '',
      scene.spatial.channels.length ? scene.spatial.channels.map(c => c.name + ' · ' + c.description).join('\n') : '원격 통신 장비가 없다. 떨어진 뒤에는 상대 장소의 말을 들을 수 없다.', '',
    ] : [scene.localRange, '']),
    '### 충돌하는 선택', '', scene.pressure, '', ...scene.choices.map(c => `- ${c}`), '',
    `**가능한 마무리:** ${scene.endings}`, '',
    `**원작 연결:** ${scene.canon}`, '', `**추가 범위:** ${scene.additions}`, '',
    '<details>', '<summary>작가용 고정 진상·단서·판정 조건 — 스포일러</summary>', '',
    ...scene.clockEvents.map(e => `- 가상 ${e.atSeconds}초 · ${e.text}`), '',
    ...scene.engineRules.map((rule, n) => `${n + 1}. ${rule}\n`), '</details>', '',
  ].join('\n')).join('\n');
  return [
    '# 서월 사건극 6선', '',
    '2026-11-07 · 원작 v1.1에 맞춘 독립 에피소드 팩. 장면 시작 때 이미 위험이 진행 중이며 각 인물은 자기 목적과 정보로 행동한다. 구조·폭력적 대치·부상·생활 기반의 손실이 가능하다. 정해진 대본이나 반드시 이겨야 하는 결말은 없다.', '',
    '## 고르기', '',
    '| 장면 | 보고 싶은 장면 | 인원 / 환경 | 파일 |', '|---|---|---|---|',
    ...outputs.map(({ scene, filename, spec }) => `| ${scene.title} | ${scene.genre} | ${spec.scenario.characters.length}명 / ${scene.spatial ? '분산' : '단일'} | [불러오기 JSON](../experiments/${filename}) |`), '',
    '**첫 실행은 「없는 층, 닫히는 문」**을 권한다. 위험·거리·목표가 한눈에 보이고 원작의 기억 기반 현상을 바로 경험할 수 있다. 힘겨루기는 「중립은 문 앞에서 끝난다」, 공간별 협업은 「01:17에 남는 사람」이 중심이다.', '',
    '## 불러오기와 실행량', '',
    '앱의 **새 실험 → JSON 편집 → 전체 설정 → 파일 가져오기**에서 표의 JSON 하나를 선택해 적용한 뒤 검증·생성한다. 인물 JSON이나 manifest를 전체 실험으로 가져오지 않는다. 외부 서버나 API를 새로 만드는 작업 없이 기존 서버에서 실행한다. 아직 서버를 시작하지 않았다면 [프로젝트 시작 안내](../../../README.md#시작하기)를 따른다.', '',
    '각 파일은 비교 조건 1개·반복 1회다. 다섯 장면은 최대 48차례, 무연역은 60차례이며 이는 인물 전체의 말·행동 차례 합계다. NPC는 Luna low, 세계 판정은 Luna medium, 진행자는 Luna low를 사용한다. NPC 모델은 시나리오 기본 설정에서 바꿀 수 있다. 독립 평가와 자동 상황 발생은 꺼져 있다. 분산 공간은 시간 계획·결과 판정 호출이 추가되므로 같은 차례 수의 단일 공간보다 호출량이 커질 수 있다.', '',
    '먼저 12~16차례로 줄이면 도입부 확인에 적합하다. 시한은 발화 수가 아닌 가상 초이므로 짧은 실행에서는 구조·공개 시한에 도달하지 않을 수 있다. 결말을 보고 싶다면 원래 한도를 사용한다. 이 모드의 실행 종료는 발화 한도 또는 사용자의 정지이며, 사건 해결만으로 자동 종료하지 않는다. 만족스러운 마무리가 나오면 정지하거나 남은 대화를 관찰할 수 있다.', '',
    '닫히는 문·무연역·겹문 대치는 **ai_spatial**, 나머지는 **ai**다. 분산 장면은 위치·통로·현장 관찰을 유지해야 하므로 환경 모드만 임의로 바꾸지 않는다. 정해진 시각의 관찰은 clockEvents에, 선택으로 피할 수 있는 결과와 그 근거는 worldEngineInstructions에 있다. 원본 생활 장면의 폭력·납치 금지 설정도 상속하지 않는다.', '',
    '## 프로젝트에서 작동하는 방식', '',
    'NPC는 공통 배경·자기 프로필·자기가 받은 관찰로 말과 행동을 선택한다. 진행자는 다음 화자를 고르며 이야기를 대신 집필하지 않는다. 세계 엔진이 실제 결과와 가상 시간을 판정하고, 분산 모드에서는 장소·이동·무전의 수신 범위를 관리한다. 판정 전용 진상과 다른 사람의 비공개 프로필을 NPC에게 넘기지 않는다. SQLite에는 설정 스냅샷·호출·대화·세계 상태가 보존되므로 이미 만든 실험은 파일을 바꿔도 갱신되지 않는다.', '',
    '이번 팩은 시작부터 열린 문, 움직이는 화물, 붙잡힌 손목, 예약 게시물, 침수 같은 구체적인 변화를 둔다. 확인할 단서는 두 경로 이상이고, 정상적인 구조·정지·수리·협상은 실제 효과가 있다. 위기를 해결하면 같은 위기를 반복해 장면을 늘리지 않는다. 살릴 수 있는 사람을 반드시 희생시키거나 원작의 장기 미스터리를 해답으로 소비하지 않는다.', '',
    '## 인물과 정사', '',
    '기존 8인의 신분·능력·한계·비공개 과거는 운영팩에서 유지한다. 기존 실행 프로필이 있는 5인은 그대로 불러오고, 강무혁·백서은·전시완의 실행 프로필 3개를 추가했다. 새 8인의 개별 생활·말투·목표·비밀은 [cast.mjs](cast.mjs)에 있다. 독립 기원 존재를 무의지적 현상으로 취급하지 않으며, 새 인물은 기존 인물의 숨겨진 혈통·실종 동료·만능 해결사로 연결하지 않았다.', '',
    '| 새 인물 | 자리와 갈등 | 프로필 |', '|---|---|---|',
    ...newCast.map(c => `| ${c.name} | ${c.identity} | [JSON](characters/${c.id}.json) |`), '',
    '기존 정사 중 추가로 실행 프로필을 만든 인물: ' + Object.entries(canonVoices).map(([id, c]) => `[${c.name}](characters/${id}.json)`).join(' · ') + '.', '',
    '모든 장면은 독립 세션이다. 같은 인물이 재등장해도 다른 파일의 부상·관계·공개 정보를 자동 승계하지 않는다. 이 팩의 구체적인 범인·장비 결함·시간 제한·서도겸의 존속 세부는 해당 에피소드용 추가안이며 원본 설정집을 덮어쓰지 않는다.', '',
    sections,
    '## 원본·재생성과 확인 범위', '',
    '- [세계관 설정집](../01_이면기록_서월_세계관설정집_v1.1.md)과 [8인 운영팩](../02_이면기록_서월_캐릭터챗_운영팩_v1.1.md)이 기존 정사 기준이다.',
    '- [scenes.mjs](scenes.mjs)는 장면·참가자별 정보·판정 조건의 원본이고 [cast.mjs](cast.mjs)는 새 인물과 추가 말투의 원본이다.',
    '- [build-drama.mjs](../build-drama.mjs)가 이 안내·[목록](manifest.json)·인물 11개·실험 6개를 만든다. 생성 JSON을 직접 바꾸면 재생성 때 덮어써진다.',
    '- 프로젝트 루트에서 `node assets/seowol/build-drama.mjs`로 새 팩만 재생성하거나 `npm run seowol:build`로 기존 서월 팩과 함께 생성한다.', '',
    '「없는 층, 닫히는 문」의 이전 장면(v1)에는 실제 API에서 24초의 문 폐쇄까지 관찰한 기록과, 모델 조합별로 16차례씩 비교한 기록이 있다. [문이 닫힌 실행의 원문](../../../docs/reviews/seowol-closing-door-2026-11-07/report.md) · [Sol과 Terra·Luna 대화 비교](../../../docs/reviews/seowol-closing-door-models-2026-11-08/report.md)', '',
    '이번 개정에서는 여섯 장면 모두 실제 Luna API로 실행했다. 8초·24초의 현장 관찰, 사진의 행방, 수정된 게시물의 공개 이후와 장기 대화의 반복은 [개정 장면 실측](../../../docs/reviews/luna-scenes-2026-11-08/report.md)에서 대조할 수 있다.', '',
  ].join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildDramaticScenes();
