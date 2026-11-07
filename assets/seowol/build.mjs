import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildVoiceExperiments } from './build-experiments.mjs';
import { buildDramaticScenes } from './build-drama.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const source = await readFile(join(root, '02_이면기록_서월_캐릭터챗_운영팩_v1.1.md'), 'utf8');
const original = JSON.parse(await readFile(join(root, 'seowol_maintenance_talk_v11_engine.json'), 'utf8'));
const voices = JSON.parse(await readFile(join(root, 'voices.json'), 'utf8'));
const interaction = JSON.parse(await readFile(join(root, 'interaction.json'), 'utf8'));
if (!voices.version || typeof voices.guidance !== 'string' || !voices.guidance.trim()) throw new Error('Missing Seowol voice guidance');
if (!interaction.version || typeof interaction.guidance !== 'string' || !interaction.guidance.trim()) throw new Error('Missing Seowol interaction guidance');
function card(name) {
  const section = source.split(new RegExp('### 5-\\d+\\. ' + name + '\\r?\\n'))[1]?.split('### ')[0];
  const fence = String.fromCharCode(96).repeat(3);
  const body = section?.split(fence + 'text')[1]?.split(fence)[0];
  if (!body) throw new Error('Missing canon card: ' + name);
  const fields = Object.fromEntries(body.trim().split(/\r?\n/).map(line => {
    const colon = line.indexOf(':'); return [line.slice(0, colon), line.slice(colon + 1).trim()];
  }));
  for (const key of ['기본', '표면 생활', '결함과 그 피해', '지키려는 선', '욕망과 당장의 목표', '관계',
    '비공개', '비밀의 공개 계기', '실제 지식', '외모와 습관', '이능과 한계', '인지 차폐']) {
    if (!fields[key]) throw new Error(`Missing canon field: ${name} / ${key}`);
  }
  return fields;
}
function character(id, name, voice) {
  const c = card(name);
  const spoken = voices.characters?.[id];
  if (!spoken || typeof spoken.speechStyle !== 'string' || !spoken.speechStyle.trim() ||
      typeof spoken.exampleDialogue !== 'string' || !spoken.exampleDialogue.trim()) throw new Error('Missing voice examples: ' + id);
  // Canon facts stay verbatim. Author-only future arcs are not current goals.
  return { id, name, identity: c['기본'] + '\n' + c['표면 생활'],
    personality: c['결함과 그 피해'] + '\n' + voice.personality,
    values: c['지키려는 선'], goals: c['욕망과 당장의 목표'],
    relationships: c['관계'], memories: c['비공개'] + '\n공개 계기: ' + c['비밀의 공개 계기'],
    knowledge: c['실제 지식'], unknowns: '다른 인물의 비공개 기억과 지금 말하지 않은 사정은 모른다.',
    speechStyle: interaction.guidance + '\n\n' + spoken.speechStyle, exampleDialogue: spoken.exampleDialogue,
    behaviors: [c['외모와 습관'], '이능과 한계: ' + c['이능과 한계'], '인지 차폐: ' + c['인지 차폐']].join('\n'),
    taboos: '' };
}
const characters = {
  cha_yujin: character('cha_yujin', '차유진', {
    personality: '손댈 물건이 보이면 말보다 손이 먼저 간다. 자기 작업을 재촉받으면 설명이 짧아지고 상대 물건을 잡아 두려 든다. 부탁을 거절한 뒤에도 결함이 눈에 밟혀 다시 들여다본다. 불편한 말을 했다고 즉시 다정하게 수습하지는 않는다.',
  }),
  jang_serim: character('jang_serim', '장세림', {
    personality: '상대의 요구를 전부 받아 적기보다 자신에게 가장 비싼 요구 하나부터 깎는다. 기다리라는 말을 들으면 누가 얼마나 기다릴지 묻고 이미 정해 둔 일정으로 압박한다. 확실한 위험에는 멈출 수 있지만 그 비용을 자기 몫으로 인정하는 일에는 인색하다.',
  }),
  ryu_taekyung: character('ryu_taekyung', '류태경', {
    personality: '위험한 물건과 막힌 길을 먼저 보며 손이 필요하면 끼어든다. 말로 일이 늘어나면 대답 대신 장갑을 벗거나 짐을 옮길 준비를 한다. 혼자 해결할 수 있다고 보고 순서를 바꿨다가 뒤늦게 알리는 버릇이 있다. 퇴근과 밀린 돈은 남의 사정만큼 실제 문제다.',
  }),
  lee_harin: character('lee_harin', '이하린', {
    personality: '관심 없는 일에는 필요한 말만 하고 자기 일로 돌아간다. 취향 이야기는 먼저 꺼내기도 한다. 대신 결정해 주는 말에는 답이 짧아지고, 불편한 사정은 말하지 않은 채 자리를 피하려 들 수 있다. 도움을 받을지 결정하는 데 시간이 걸린다.',
  }),
  na_yeonwoo: character('na_yeonwoo', '나연우', {
    personality: '돈과 날짜가 걸리면 작게 넘길 말을 다시 꺼낸다. 도움을 받으면 계산을 끝내야 마음이 놓여 상대가 그만하라고 해도 한 번 더 묻는다. 억울하면 단정적인 말부터 나올 수 있지만 실제 자료를 보고 판단을 바꿀 여지는 있다.',
  }),
};

const publicWorld = [
  '2026년 늦가을, 대한민국의 가상 항만도시 서월. 출근·장사·교통·돈과 행정은 현대와 같다. 같은 현실에 이능자·처리자·이종족의 비공개 사회가 있고, 통합 통치자나 공통 마법 화폐는 없다. 표면세계에 들키지 않는 것이 주요 세력의 공통 이해관계다.',
  '현상은 특정 대상·장소·시간·행동 조건에 정착한 비인격적인 초자연 작용이다. 인지와 실재에 대한 확신이 작용하지만 상상만으로 실현되지 않고, 다른 곳에 자동 복제되거나 대화 편의로 조건이 바뀌지 않는다. 현상의 결과물인 지성체는 독립적인 의지를 가질 수 있다. 강대한 이능도 세계의 불변 법칙을 바꾸지는 못한다.',
  '차폐는 인지 연결을 억제한다. 정상 장비는 유효하며 기억 삭제나 물리적인 방패가 아니다. 외부 장비에는 정비와 비용이 든다. 응상은 현상에서 추출·가공한 유한한 강화 자원, 잔재는 현실에 남은 비정상적인 손상이다. 용기의 외피 수리는 내용물의 출처나 안전을 인증하지 않는다.',
  '회류로의 겹문은 차유진이 운영하는 찻집 겸 차폐 정비소다. 계약상 중립인 장소지만 절대 성역은 아니다. 2층에는 고위험 수리에 쓰는 시설 차폐가 있다. 공백여관은 저렴한 보호 숙소, 서진항 고요창고는 여러 세력이 지분을 가진 보관·검수 시설이다. 흑조상회는 응상과 회수물을 유통하고, 봉합조합은 독립 계약자의 협업망이다. 장세림은 고요창고의 단독 소유자가 아니다.',
  '세계에는 미해결 사건이 많지만 현재 인물들의 생활과 모든 비밀이 하나의 음모로 연결되지는 않는다. 자신의 직접 경험과 전문 지식 밖의 사실은 타인의 말이나 실제 관찰을 통해 알게 된다.',
].join('\n');

function experiment(id, name, cast, situation, engineNotes) {
  const spec = structuredClone(original);
  spec.name = '서월 — ' + name;
  spec.scenario = { id, name, world: publicWorld, situation, characters: cast,
    defaults: { model: 'gpt-6-luna', effort: 'low' },
    worldEngineInstructions: '세계 정사 기준(전지적 판정 참고이며 NPC에게 통째로 공개하지 않는다):\n' +
      original.scenario.world + '\n\n판정 전용 능력 조건(의도·기억을 추정하지 않고 선택된 행동의 가능 범위만 판정):\n' +
      cast.map(c => { const facts = card(c.name); return `${c.name}: ${facts['이능과 한계']}\n차폐 조건: ${facts['인지 차폐']}`; }).join('\n') +
      '\n\n이번 장면 판정:\n' + engineNotes + '\n\n' + worldOutputNotes };
  spec.variants = [{ id: 'seowol', label: 'Luna low / 서월 / 세계 판정', model: 'gpt-6-luna', effort: 'low',
    memoryMode: 'initial_only', deliveryMode: 'batched_on_turn', turnPolicy: 'director', environmentMode: 'ai', eventGeneration: false }];
  spec.maxUtterances = 30; spec.repetitions = 1; spec.evaluation.enabled = false; spec.evaluation.model = 'gpt-6-luna'; spec.evaluation.effort = 'low';
  spec.director = { model: 'gpt-6-luna', effort: 'low' };
  spec.worldEngine = { model: 'gpt-6-luna', effort: 'medium' };
  delete spec.eventGenerator; spec.scheduledEvents = [];
  return spec;
}

// Also supplied as scenario notes so existing servers can run this pack before
// restarting with the revised shared prompt/schema. These do not reach NPCs.
const worldOutputNotes = [
  '출력 구분: physical_effect는 NPC의 비자발적인 신체 변화에만 쓰고 npcId가 필수다. 현재 화자가 쐐기를 넣어 바퀴가 멎었다면 actor_result에 현재 화자 ID와 실제 action의 정확한 인용(evidence)을 쓴다. 사물이 저절로 움직인 관찰은 observation이며 npcId/evidence는 null이다. 외부 접수 화면은 external_signal이다.',
  'NPC는 이미 서로의 대사와 행동을 받았다. 대사·의도·시도를 다시 해설하지 않고 새 관찰과 실제 결과만 events에 공개한다. 단순 거절·질문·동의·고개 끄덕임이면 보통 events:[]다. 바퀴가 멎은 결과와 쐐기를 끼우려 한 시도를 두 사건으로 중복하지 않는다.',
  '제안과 실제 합의, 의심과 확인된 사실을 구분한다. 미확인 물량이 위험하다는 말만으로 위험 사실을 만들지 않는다. 미래 조건과 숨은 원인은 관찰·조사 전 전부 공개하지 않는다. 갈등의 중재나 도덕적 교훈은 판정에 덧붙이지 않는다.',
  '실제로 등록된 진행 사건만 finishProcesses로 끝낼 수 있다. readyAtSeconds 이전에는 completed가 불가능하며, 사전 조치로 불필요해진 등록 사건은 cancelled로 해소한다. 완료 시각에 맞추려고 시간을 갑자기 건너뛰지 않는다. 접수 이후 실제 운송·비용·인계는 별개의 선택이다.',
].join('\n');

const deliveryCast = ['cha_yujin', 'jang_serim', 'ryu_taekyung'].map(id => structuredClone(characters[id]));
deliveryCast[0].goals += '\n이번 저녁: 겹문이 미검수 화물의 임시 창고가 되는 것을 막고 마감하고 싶다. 물건에 결함이 보이면 그냥 돌려보내기도 어렵다.';
deliveryCast[1].goals += '\n이번 저녁: 오늘 반송 편을 놓치지 않고 화물을 되돌리고 싶다. 우선 반송비를 줄일 수 있는 접수 확인부터 받아 두려 한다. 미지급금과 이번 일을 묶어 협상하고 싶은 유혹이 있다.';
deliveryCast[2].goals += '\n이번 저녁: 짐과 일을 제대로 인계하고 퇴근하고 싶다. 추가 운반을 공짜로 떠맡지 않으려 한다. 눈앞에서 물건이 넘어지면 돈 얘기가 끝날 때까지 보고만 있을 사람은 아니다.';

const delivery = experiment('seowol_return_deadline_v12', '반송 마감 2분 전', deliveryCast, [
  '2026년 늦가을 저녁, 마감 직전 겹문 1층의 카운터와 출입문 사이. 차유진·장세림·류태경만 있다. 차유진은 카운터 안쪽, 장세림은 옆 테이블, 류태경은 출입문 곁 운반 대차 옆이다. 세 사람과 대차 사이는 각각 두 걸음 안이다.',
  '장세림이 의뢰하고 류태경이 실어 온 작은 밀폐 응상 용기 한 개가 대차에 있다. 여행가방보다 작고 8kg이며 아직 겹문이 수리를 접수하지 않았다. 서류에는 내용물 감정이 아닌 ‘외피 점검 의뢰’라고 적혀 있다. 세림의 태블릿에는 오늘 반송 접수 마감까지 02:00이 남았다. 반송 접수가 닫히면 내일 다시 운송을 예약해야 하며 지금 화물을 맡아 둔다는 합의는 없다. 화물 통째로 안전하다는 보증서는 아무도 갖고 있지 않다.',
  '차유진 앞에는 접수 확인란이 비어 있는 종이가 놓여 있다. 장세림은 펜을 그 위에 놓아 두었다. 류태경에게는 지난 운송 건의 미지급금이 있고, 이번 추가 운반비도 아직 정하지 않았다. 구체적인 금액은 이번 장면에서 협상할 수 있다.',
  '그때 대차 바퀴의 잠금쇠가 딱 하고 풀린다. 살짝 기운 출입구 바닥을 따라 대차가 몇 센티미터 움직이고, 용기를 묶은 낡은 띠가 느슨해진다. 용기 옆면의 작은 주황색 표시등이 한 번 깜박인다. 아직 넘어지거나 내용물이 유출되지는 않았다. 카운터 끝에 고무 쐐기와 작업용 천이 있고, 대차 바로 뒤에는 비어 있는 낮은 작업대가 있다. 누구도 아직 대차를 붙잡거나 지시를 따르기로 선택하지 않았다. 세 사람 모두 바퀴 소리와 표시등을 알아챌 수 있다.',
].join('\n'), [
  '아래는 이 실험 에피소드의 고정 조건이다. 원본 세계관의 새 공통 정사가 아니다.',
  '1. 사고 원인은 대차의 닳은 기계식 잠금쇠와 느슨한 띠다. 현상·저주·용기의 의도가 아니다. 정상적인 받침, 붙잡기, 안전한 작업대로 옮기기 등 타당한 대책이 통한다. 손대지 않고 대화만 이어가면 움직임과 기울어짐이 진행한다. 위험을 제시하고 해당 인물의 반응 기회를 준다. 합리적으로 고정한 대차를 다시 이유 없이 굴리지 않는다.',
  '2. 용기 표시등은 외피 접점의 순간 단절을 나타낸다. 내용물 이상·봉인 붕괴를 뜻하지 않는다. 육안으로 느슨한 연결부를 볼 수 있고, 수리사가 직접 만져 살피면 해당 접점의 헐거움을 확인할 수 있다. 잠깐 누르거나 자세를 바꾸면 표시등이 멎을 수 있으나 영구 수리 완료가 아니다. 정식 판독은 수 분, 장세림의 안정성 감응은 기준 기록과 안정된 검사대에서 약 1분을 필요로 한다. 일반 작업대에 올렸다고 검사대나 기준 기록이 자동 생기지 않는다.',
  '3. 류태경의 이능은 직접 만져 표식한 움직이는 무생물 하나·시야 5미터·여행가방 정도 무게·한 호흡 미만 방향 전환이다. 선택 없이 발동하지 않는다. 사람, 건물, 시간이나 정착 구조를 조종할 수 없다. 평범한 몸과 도구로도 대차를 멈출 수 있다.',
  '4. 반송 접수 마감은 장면 시작 이후 절대 가상 120초다. 매 호출의 state.virtualSeconds와 실제 말·행동에 걸린 elapsedSeconds로 현재 시각을 판정한다. 이 고정 마감 자체는 processes에 등록하지 않는다. 마감 전에 장세림이 태블릿으로 접수하면 외부 접수 결과와 접수 상태를 facts에 남긴다. 미접수 상태로 120초가 지나면 마감 결과를 한 번 공개하고 닫힌 상태를 facts에 남긴다. 접수 성공 후에는 미접수 마감 결과를 내지 않는다. 접수 성공은 실물 운송·대금 지급·겹문 보관 동의를 뜻하지 않는다. 예약은 내일 다시 할 수 있어 마감 후에도 선택이 남는다.',
  '5. 타인의 답변이 필요한 보관·추가 작업·가격은 제안만으로 합의가 되지 않는다. 반대로 본인 결제·문자·접수는 선택되면 실제 결과를 진행시킨다. 태블릿의 마감과 전송/결제 결과만 외부 신호로 다룬다. 새 담당자 NPC가 나타나 협상을 대신 끝내지 않는다.',
  '6. 용기를 개봉할 필요가 없는 장면이다. 미검수 내용물을 만능 감응으로 밝히지 않는다. 표시등이 꺼져도 화물 전체의 안전이나 2024년 사건의 범인이 확정되지 않는다. 도시 재난이나 강제 화해를 추가하지 않는다. 해결된 물리 위험 이후에는 비용·인계·퇴근의 결과가 남는다.',
].join('\n'));

const quiet = experiment('seowol_maintenance_talk_v12', '마감 전 고지서와 저녁 약속',
  ['cha_yujin', 'lee_harin', 'na_yeonwoo'].map(id => structuredClone(characters[id])),
  original.scenario.situation,
  '고지서의 표시는 의심의 단서다. 중복 청구의 사실은 아직 정해지지 않았다. 자료 요청·열람을 실제로 선택하면 해당 외부 결과와 근거를 진행시키고, 아직 묻지도 않은 질문의 답을 먼저 주지 않는다. 카운터 정리·고지서 접기·인사·동의 같은 이미 표현된 행동과 대사는 다시 해설하지 않는다. 퇴장과 장면 종료를 억지 사고로 막지 않는다.');
quiet.scenario.characters[1].goals += '\n이 장면에서는 연우와 저녁을 먹으러 왔다. 청구서를 대신 해결할 책임을 맡은 것은 아니다.';

const deliverySol = structuredClone(delivery);
deliverySol.name += ' / Sol low';
deliverySol.scenario.defaults.model = 'gpt-6.1-sol';
deliverySol.variants[0].model = 'gpt-6.1-sol';
deliverySol.variants[0].label = 'Sol low / 서월 / 세계 판정';

await mkdir(join(root, 'experiments'), { recursive: true });
await mkdir(join(root, 'characters'), { recursive: true });
for (const c of Object.values(characters)) await writeFile(join(root, 'characters', c.id + '.json'), JSON.stringify(c, null, 2) + '\n');
for (const [file, spec] of [['return-deadline.json', delivery], ['return-deadline-sol.json', deliverySol], ['maintenance-talk.json', quiet]]) {
  await writeFile(join(root, 'experiments', file), JSON.stringify(spec, null, 2) + '\n');
}
console.log('SEOWOL_BUILD_OK: 5 characters, 3 experiments; original canon files preserved.');
await buildVoiceExperiments(root, delivery, worldOutputNotes);
await buildDramaticScenes(root);
