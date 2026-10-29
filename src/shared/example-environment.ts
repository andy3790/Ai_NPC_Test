import { environmentSchema } from './schema.js';
// Authored scenario rules, not facts improvised by an NPC or an AI narrator.
export const harborEnvironment = () => environmentSchema.parse({
  enabled: true, stopOnGoals: true,
  initialState: { oilChecked: false, plan: 'undecided', yoonAgreed: false, dohaAgreed: false, miruAgreed: false, lampReady: false, lampLit: false, planRecorded: false },
  actions: [
    { id: 'inspect_oil', label: '남은 기름을 직접 확인한다', actorIds: ['yoon', 'doha', 'miru'], conditions: [{ key: 'oilChecked', value: false }], effects: { oilChecked: true }, result: '남은 기름을 확인했다. 설정대로 한 통이다. 정확한 부피와 연소 시간은 아직 측정되지 않았다.' },
    { id: 'propose_tonight', label: '오늘 밤 사용을 우선하는 방침을 제안한다', actorIds: ['yoon', 'doha', 'miru'], conditions: [{ key: 'oilChecked', value: true }, { key: 'plan', value: 'undecided' }], effects: { plan: 'tonight' }, result: '오늘 밤 사용을 우선하는 방침이 공개 제안되었다. 아직 다른 인물의 동의는 확정되지 않았다.' },
    { id: 'propose_reserve', label: '오늘 점등하되 일부는 다음 날을 위해 남기는 방침을 제안한다', actorIds: ['yoon', 'doha', 'miru'], conditions: [{ key: 'oilChecked', value: true }, { key: 'plan', value: 'undecided' }], effects: { plan: 'reserve' }, result: '오늘 점등하되 일부는 다음 날을 위해 남기는 방침이 공개 제안되었다. 정확한 배분량과 다른 인물의 동의는 아직 확정되지 않았다.' },
    ...['yoon', 'doha', 'miru'].map((actor, i) => ({ id: `agree_${actor}`, label: '현재 제안에 본인이 동의한다', actorIds: [actor], conditions: [{ key: 'plan', op: 'neq', value: 'undecided' }, { key: `${actor}Agreed`, value: false }], effects: { [`${actor}Agreed`]: true }, result: `${['윤이', '도하가', '미루가'][i]} 현재 제안에 동의했다. 이는 이 인물의 동의만 확정하며 다른 인물의 의사를 대신하지 않는다.` })),
    { id: 'prepare_lamp', label: '합의한 방침에 따라 등불에 기름을 공급한다', actorIds: ['yoon', 'doha'], conditions: [{ key: 'oilChecked', value: true }, ...['yoon', 'doha', 'miru'].map(actor => ({ key: `${actor}Agreed`, value: true })), { key: 'lampReady', value: false }], effects: { lampReady: true }, result: '합의한 사용 방침에 따라 등불에 기름을 공급했고 점등 준비가 완료되었다. 준비 과정에서 기름을 흘리지 않았다. 공급량과 연소 지속 시간은 수치로 측정되지 않았다.' },
    { id: 'ignite_lamp', label: '준비된 등불에 불을 붙인다', actorIds: ['yoon'], conditions: [{ key: 'lampReady', value: true }, { key: 'lampLit', value: false }], effects: { lampLit: true }, result: '윤의 점화 시도로 등불에 불이 붙었고 지금 빛을 내고 있다. 밤새 지속된다는 보장이나 미래 날씨에 관한 정보는 생기지 않았다.' },
    { id: 'record_plan', label: '합의한 방침과 확인된 점등 결과를 수첩에 기록한다', actorIds: ['miru'], conditions: [{ key: 'lampLit', value: true }, { key: 'planRecorded', value: false }], effects: { planRecorded: true }, result: '미루가 선택한 기름 사용 방침과 점등을 확인한 사실을 수첩에 기록했다. 정확한 연소 시간과 미래 날씨는 미확인으로 남겼다.' },
  ],
  goals: [
    { id: 'agreement', label: '세 인물이 기름 사용 방침에 직접 동의한다', conditions: ['yoon', 'doha', 'miru'].map(actor => ({ key: `${actor}Agreed`, value: true })) },
    { id: 'light', label: '등불의 점등을 확인한다 (밤샘 유지 보장과 구분)', conditions: [{ key: 'lampLit', value: true }] },
    { id: 'record', label: '미루가 방침과 확인 결과를 기록한다', conditions: [{ key: 'planRecorded', value: true }] },
  ],
});
