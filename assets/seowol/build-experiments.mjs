import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

// Experimental additions are separate from the user's canon cards.
export async function buildVoiceExperiments(root, template, worldNotes) {
  const cast = JSON.parse(await readFile(join(root, 'experimental-cast.json'), 'utf8'));
  const interaction = JSON.parse(await readFile(join(root, 'interaction.json'), 'utf8'));
  const interim = JSON.parse(await readFile(join(root, 'review-variants/interaction-v3.json'), 'utf8'));
  const previousVoice = JSON.parse(await readFile(join(root, 'voices.json'), 'utf8'));
  const spec = structuredClone(template);
  spec.name = '서월 문체 실험 — 테이프 감은 앰프';
  spec.scenario.id = 'seowol_amplifier_v1';
  spec.scenario.name = '테이프 감은 앰프';
  spec.scenario.defaults = { model: 'gpt-6.1-sol', effort: 'low' };
  spec.scenario.world += '\n이번 실험의 추가 장소는 회류로의 작은 수리점 세칸전파다. 삼중문 협동조합에 일반 부품과 기초 차폐 장비 정비를 납품한다. 작업장의 설비 차폐는 정상이며 현재 초자연 재난은 없다. 새 인물·가게는 문체 검토용 제안으로, 기존 인물의 과거나 세계의 법칙을 바꾸지 않는다.';
  spec.scenario.situation = [
    '2026년 늦가을 저녁, 영업을 끝낸 세칸전파. 임소진은 작업대에서 막 도시락 뚜껑을 열었고 고복만은 옆 접이식 의자에 앉아 있다. 백도하가 빌렸던 소형 앰프를 들고 들어와 작업대 빈 곳에 놓았다. 세 사람은 서로 잘 아는 사이며 모두 이면사회의 존재를 안다. 오늘의 모임은 회의나 공동 의뢰가 아니다.',
    '앰프의 한쪽 모서리에는 새 검은 테이프가 감겨 있다. 전원은 아직 연결하지 않았다. 도하는 앰프를 다시 가져가려고 왔고 복만에게 오늘 밤까지 빌렸다. 도하의 베이스와 케이블, 앰프 전원선이 가방에 있다. 작업대에는 소진의 공구와 벽 콘센트가 있다. 복만은 도하가 앰프를 내려놓는 것을 보고 새 테이프를 손가락으로 가리킨다. 아직 아무도 테이프를 벗기거나 고장을 확인하지 않았다.',
    '도하가 운반하며 어떤 일을 겪었는지, 소진이 연습 영상을 어떻게 봤는지, 복만이 왜 이 물건을 아끼는지는 각자가 말하거나 행동으로 드러내기 전에는 다른 사람이 모른다. 지금까지 이 자리에서 오간 대사는 없다.'
  ].join('\n');
  const physicalNotes = [
    '이하 인물·가게·고장은 이번 실험에만 추가한 조건이다. 기존 세계 정사에 소급하지 않는다. 등장인물 셋은 선택 가능한 이능이 없다. 고복만은 모체와 독립한 현상기원 인격이며 생리와 행동은 프로필대로다. 출신은 초능력이나 물리적 면역이 아니다. 작업장 차폐는 인지에만 작용한다.',
    '앰프는 평범한 전자기기다. 실제로 도하가 낮에 떨어뜨렸고 테이프 안쪽 모서리 플라스틱이 깨졌다. 손잡이는 고정돼 있다. 전원을 연결하면 켜지지만 입력 잭 접점이 헐거워 케이블 각도에 따라 소리가 끊긴다. 베이스와 케이블을 연결해 시험하거나 직접 열어 점검하면 이 단서를 관찰할 수 있다. 테이프만 벗겨도 내부 회로까지 진단되지는 않는다. 정상적인 부품과 납땜으로 수리할 수 있고 실제 작업에는 수 분이 걸린다. 대화만으로 저절로 고쳐지지 않는다.',
    '초기 앰프는 작업대에 있고 전원은 꺼져 있다. 물건 위치·누가 들고 있는지·전원·테이프·실제 확인된 손상은 facts로 지속시킨다. 본인 소유 공구나 손에 든 물건을 조작할 수 있으며 손 뻗기·건네 달라는 말은 상대의 동의를 확정하지 않는다. 소유·대여·양도는 구분한다. 앰프를 두고 간다고 자동 양도되지 않는다.',
    '고장 원인과 비공개 사정은 관찰 전에 사건으로 설명하지 않는다. 도하가 떨어뜨리지 않았다고 말해도 물리적 과거는 바뀌지 않는다. NPC의 의심은 그 인물의 판단이며 판정자가 진실이나 거짓말임을 중계하지 않는다. 말싸움의 승자·사과·화해·수리 합의를 엔진이 결정하지 않는다.',
    '식사·장비 시험·퇴장은 유효한 선택이다. 아무도 대화의 갈등을 끝낼 의무가 없다. 위험을 키우기 위한 화재·감전·현상·새 인물·전화는 만들지 않는다. 접수 마감이나 계약 협상은 이 장면의 필수 목표가 아니다.'
  ].join('\n');
  spec.scenario.worldEngineInstructions = physicalNotes + '\n\n' + worldNotes;
  spec.maxUtterances = 18; spec.repetitions = 1;
  spec.concurrentRuns = 1; spec.maxConcurrentCalls = 1;
  spec.variants = [{ id: 'interaction', label: '내용 반응 / Sol low', model: 'gpt-6.1-sol', effort: 'low',
    memoryMode: 'initial_only', deliveryMode: 'batched_on_turn', turnPolicy: 'director', environmentMode: 'ai', eventGeneration: false }];
  spec.scheduledEvents = [];
  const assignCast = (guidance) => cast.characters.map(c => ({ ...c, speechStyle: guidance + '\n\n' + c.speechStyle }));
  spec.scenario.characters = assignCast(interaction.guidance);
  const baseline = structuredClone(spec);
  baseline.name += ' / 이전 문체 지침';
  baseline.variants[0].id = 'previous_voice'; baseline.variants[0].label = '이전 말투 지침 / Sol low';
  baseline.scenario.characters = assignCast(previousVoice.guidance);
  const quiet = structuredClone(spec);
  quiet.name = '서월 문체 실험 — 연습 영상 틀어 놓은 저녁';
  quiet.scenario.id = 'seowol_video_dinner_v1'; quiet.scenario.name = '연습 영상 틀어 놓은 저녁';
  quiet.scenario.situation = '별도의 저녁이다. 앞 실험의 대화나 사건은 일어나지 않았다. 세칸전파 영업을 마치고 임소진은 도시락을 먹고 있다. 백도하가 작업대에 자기 휴대전화를 세워 지난주 밴드 연습 영상을 재생했고, 고복만은 옆 의자에서 자기 몫의 빵을 뜯고 있다. 영상은 연주 중간이며 별도 인물은 현장에 없다. 셋 모두 영상의 베이스 소리가 작은 것을 들을 수 있다. 소진은 지난주 이 영상을 이미 본 적이 있다. 앰프 대여나 수리 의뢰는 없는 날이며 다급한 외부 사건도 없다. 도하가 영상을 켠 뒤 아직 아무 말도 오가지 않았다.';
  quiet.scenario.worldEngineInstructions = '일상적인 식사·영상 재생·대화 장면이다. 휴대전화와 외부 차폐는 정상이다. 영상은 도하가 베이스를 치는 밴드 연습이며 베이스 소리가 작고 드럼이 크게 녹음됐다. 영상에 현상·새 비밀·기존 인물을 숨겨 넣지 않는다. 평범한 기기 조작과 음식 이동의 결과만 판정하고, 취향·의도·감정·칭찬·관계 개선은 NPC가 결정한다. 재난·전화·계약·수리 의뢰로 대화에 목표를 만들어 주지 않는다. 대사나 사소한 몸짓을 다시 중계하지 않는다.\n' + worldNotes;
  for (const c of quiet.scenario.characters) {
    if (c.id === 'test_baek_doha') {
      c.goals = '소진과 복만에게 자기 연주를 들어 보라고 하고 싶다. 반응이 신경 쓰이지만 칭찬해 달라고 직접 말하기는 싫다.';
      c.memories = '지난주 이 연습 영상을 소진에게 보냈는데 소리 작다라는 답만 왔다. 소진이 좋아할 줄 알았다.';
    }
    if (c.id === 'test_im_sojin') {
      c.goals = '도시락을 먹고 쉬고 싶다. 음악은 좋아하지만 오늘 하루 종일 남의 부탁을 들었다.';
      c.unknowns = '도하가 오늘 자기 반응을 얼마나 기대하는지, 복만이 어떤 노래를 들려주고 싶어 하는지는 직접 드러나기 전에는 모른다.';
      c.knowledge = c.knowledge.replace(' 이 앰프를 열어 보거나 시험하지 않고 내부 고장을 확정할 수 없다.', '');
    }
    if (c.id === 'test_go_bokman') {
      c.goals = '앉아서 빵을 먹으며 쉬고 싶다. 자기가 좋아하는 옛 노래도 들려주고 싶지만 오늘은 도하가 전화기를 먼저 켰다.';
      c.memories = '도하가 밴드를 한다는 것은 알지만 이 영상은 처음 본다. 소진과 함께 가게 정리를 하다 간식을 먹은 적이 있다.';
      c.unknowns = '이 영상에 관해 도하와 소진이 예전에 무슨 말을 했는지, 상대들의 속마음은 아직 모른다.';
    }
  }
  await mkdir(join(root, 'experimental-characters'), { recursive: true });
  for (const c of spec.scenario.characters) await writeFile(join(root, 'experimental-characters', c.id + '.json'), JSON.stringify(c, null, 2) + '\n');
  const interimAmp = structuredClone(spec);
  interimAmp.name += ' / 반응 지침 v3';
  interimAmp.scenario.characters = assignCast(interim.guidance);
  const interimDinner = structuredClone(quiet);
  interimDinner.name += ' / 반응 지침 v3';
  for (const c of interimDinner.scenario.characters) c.speechStyle = interim.guidance + '\n\n' + cast.characters.find(x => x.id === c.id).speechStyle;
  for (const [file, value] of [['strong-voices.json', spec], ['strong-voices-baseline.json', baseline], ['strong-voices-dinner.json', quiet],
    ['strong-voices-v3.json', interimAmp], ['strong-voices-dinner-v3.json', interimDinner]]) {
    await writeFile(join(root, 'experiments', file), JSON.stringify(value, null, 2) + '\n');
  }
  console.log('SEOWOL_VOICE_EXPERIMENTS_OK: 3 new actors, v2 control + v3/v4 amplifier and dinner scenes.');
}
