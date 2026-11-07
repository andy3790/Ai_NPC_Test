import { experimentSchema, type ExperimentSpec, type ModelConfig } from './schema.js';
import { apiRoleDefaults } from './role-models.js';

export function spatialExample(model?: string, effort = apiRoleDefaults.npc.effort, helpers?: { worldEngine: ModelConfig; director: ModelConfig }): ExperimentSpec {
  const config = { model: model ?? apiRoleDefaults.npc.model, effort };
  const roles = helpers ?? (model === undefined ? apiRoleDefaults : { worldEngine: config, director: config });
  return experimentSchema.parse({ schemaVersion: 1, name: '기지의 오후 · 분산 공간',
    scenario: { id: 'station-afternoon', name: '기지의 오후', defaults: config,
      world: '작은 해양 관측기지에는 작업실, 휴게실, 관제실이 있다. 네 동료가 근무한다. 작업실에는 공구와 점검할 환풍기가 있고 휴게실에는 물컵, 탁자, 휴지가 있다. 모든 방은 설정된 통로로 연결된다. 휴대 무전기로 공용 업무 채널을 사용한다. 초자연적 능력과 새로운 핵심 시설은 없다.',
      situation: '오후의 일과가 시작된다. 각자 현장에서 할 일을 정하고 필요하면 동료와 연락한다.',
      characters: [
        { id: 'yoon', name: '윤', identity: '설비 담당', personality: '꼼꼼하지만 친한 동료에게는 장난스럽다.', goals: '환풍기를 점검하고 쉬는 시간을 갖는다.', speechStyle: '친근한 존댓말. 짧고 구체적으로 말하며 업무 밖에서는 가벼운 농담도 한다.', behaviors: '작업 전 소매를 걷는다.' },
        { id: 'miru', name: '미루', identity: '관측 담당', personality: '차분하고 호기심이 많다.', goals: '잠깐 쉬며 동료의 근황을 듣고 관제실을 둘러본다.', speechStyle: '부드러운 반말, 궁금한 일은 솔직하게 묻는다.', behaviors: '생각할 때 컵의 손잡이를 만진다.' },
        { id: 'doha', name: '도하', identity: '운영 담당', personality: '활발하고 실용적이다.', goals: '휴게실을 정리하고 필요한 동료를 돕는다.', speechStyle: '격식 없는 반말, 구체적인 제안과 짧은 농담.', behaviors: '말하면서 주변 물건을 정돈한다.' },
        { id: 'serin', name: '세린', identity: '통신 담당', personality: '느긋하고 관찰력이 좋다.', goals: '관제실의 통신 상태를 살피고 동료들과 휴식 계획을 잡는다.', speechStyle: '편안한 존댓말, 상황에 맞는 비유를 가끔 쓴다.', behaviors: '답하기 전에 잠깐 창밖을 본다.' },
      ],
      spatial: { locations: [
        { id: 'workshop', name: '작업실', description: '공구대와 환풍기가 있는 작업 공간.', initialSituation: '환풍기에서 평소보다 큰 진동음이 난다.' },
        { id: 'lounge', name: '휴게실', description: '탁자와 의자, 물컵과 휴지가 있는 휴식 공간.', initialSituation: '탁자 가장자리에 물컵이 놓여 있다.' },
        { id: 'control', name: '관제실', description: '기지 통신 장비가 있는 공간.', initialSituation: '통신 장비에는 현재 경고 표시가 없다.' },
      ], connections: [
        { id: 'work-lounge', from: 'workshop', to: 'lounge', bidirectional: true, description: '보통 걸음으로 이동할 수 있는 짧은 실내 통로.' },
        { id: 'lounge-control', from: 'lounge', to: 'control', bidirectional: true, description: '문 하나와 짧은 복도를 지나는 통로.' },
      ], initialPositions: [{ npcId: 'yoon', locationId: 'workshop' }, { npcId: 'miru', locationId: 'lounge' }, { npcId: 'doha', locationId: 'lounge' }, { npcId: 'serin', locationId: 'control' }],
      channels: [{ id: 'radio', name: '업무 무전', memberNpcIds: ['yoon', 'miru', 'doha', 'serin'], description: '모두 휴대 무전기를 가지고 있다. 말만 들리며 영상은 전달하지 않는다.' }] },
      worldEngineInstructions: '오래 걸리는 작업 사이에 다른 장소의 대화와 행동이 진행될 수 있다. 사소한 몸짓은 반복 중계하지 않는다.',
    },
    variants: [
      { id: 'spatial-quiet', label: '분산 공간 · 상황 발생 끔', environmentMode: 'ai_spatial', deliveryMode: 'batched_on_turn', eventGeneration: false },
      { id: 'spatial-events', label: '분산 공간 · 상황 발생 켬', environmentMode: 'ai_spatial', deliveryMode: 'batched_on_turn', eventGeneration: true },
    ], worldEngine: roles.worldEngine, director: roles.director, evaluation: { ...roles.director, enabled: true, interval: 10 }, maxUtterances: 60,
    eventGenerator: { ...roles.director, intervalSeconds: 30, minGapSeconds: 60, maxChecks: 20, maxProposals: 5, maxSeverity: 'medium',
      allowedEvents: '기존 설비의 작은 고장, 컵의 물이 흘러내리는 사고, 기존 무전기의 잡음. 관찰 가능한 징후를 통해 대응할 계기를 만든다.',
      forbiddenEvents: '사망·중상·기지 파괴·새 인물 등장·새 시설·강제 감정이나 동료의 자발적 싸움.' },
  });
}
