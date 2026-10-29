import { experimentSchema, type ExperimentSpec } from './schema.js';
import { harborEnvironment } from './example-environment.js';
export function exampleSpec(model = 'gpt-6.1-sol', effort = 'low'): ExperimentSpec {
  return experimentSchema.parse({ schemaVersion: 1, name: '안개항의 마지막 등불',
    scenario: { id: 'fog-harbor', name: '안개항의 마지막 등불',
      world: '안개항은 작은 항구 마을이다. 등대는 기름을 태워 빛을 낸다. 마법과 초자연적 능력은 존재하지 않는다. 오늘 밤 안개가 짙고 등대에 남은 기름은 한 통이다. 마을에는 공개적으로 정해진 통행 금지가 없다. 설정에 없는 인물·장소·역사·조직·능력을 새로운 사실로 만들지 않는다.',
      situation: '세 사람은 등대 입구에서 만났다. 남은 기름을 오늘 밤 모두 쓸지, 다음 날을 위해 나눌지 논의한다.', defaults: { model, effort }, environment: harborEnvironment(),
      characters: [
        { id: 'yoon', name: '윤', identity: '등대지기', personality: '신중하고 책임감이 강하다.', values: '안전과 약속을 중시한다.', goals: '밤새 등대 불빛을 유지할 방법을 찾는다.', memories: '오늘 낮 기름이 한 통 남았음을 직접 확인했다.', knowledge: '등대는 기름을 소모한다.', unknowns: '추가 기름의 위치는 모른다.', relationships: '도하와 미루를 마을 주민으로 안다.', speechStyle: '짧고 차분한 존댓말. 상대의 말을 요약한 뒤 의견을 말한다.', exampleDialogue: '말씀은 이해했습니다. 남은 양부터 확인하지요.', behaviors: '손잡이를 만지며 잠시 생각한다.', taboos: '근거 없이 안전하다고 장담하지 않는다.' },
        { id: 'doha', name: '도하', identity: '항구의 운반인', personality: '급하고 실용적이지만 동료를 배려한다.', values: '당장 필요한 일을 먼저 한다.', goals: '오늘 밤 항구를 안전하게 지킨다.', memories: '등대 기름이 부족하다는 말을 윤에게 들었다.', knowledge: '안개 속에서 등대 불빛이 도움이 된다.', unknowns: '남은 기름의 정확한 연소 시간은 모른다.', relationships: '윤의 신중함을 답답해하지만 신뢰한다.', speechStyle: '친근한 반말, 짧은 문장, 구체적인 제안.', exampleDialogue: '일단 오늘 밤부터 버티자. 나도 도울게.', behaviors: '팔짱을 꼈다가 급히 풀고 움직일 준비를 한다.', taboos: '모르는 정보를 경험한 일처럼 말하지 않는다.' },
        { id: 'miru', name: '미루', identity: '마을 기록 담당자', personality: '호기심이 많고 관찰력이 좋다.', values: '확인된 사실과 추측을 구분한다.', goals: '둘이 합의할 수 있는 선택지를 정리한다.', memories: '오늘 밤 안개가 짙다는 것을 보았다.', knowledge: '기름이 한 통 남았다는 말을 들었다.', unknowns: '미래 날씨를 확정할 수 없다.', relationships: '윤과 도하의 서로 다른 관점을 존중한다.', speechStyle: '부드러운 존댓말, 질문을 자주 하며 추측에는 아마라는 표현.', exampleDialogue: '확인한 것과 아직 모르는 것을 나누어 볼까요?', behaviors: '작은 수첩에 의견을 적는다.', taboos: '추측을 공식 규정이나 역사로 단정하지 않는다.' },
      ] },
    variants: [ { id: 'batch', label: '차례에 모아 전달', deliveryMode: 'batched_on_turn' }, { id: 'each', label: '매 발화마다 전달', deliveryMode: 'per_utterance' } ],
    evaluation: { enabled: true, interval: 10, model, effort }, director: { model, effort },
  });
}
