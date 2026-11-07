# 실험 JSON 작성과 요구사항 변환 가이드

NPC Dialogue Lab의 실험 설정 파일은 `schemaVersion: 1`인 JSON 객체입니다. 세계관·캐릭터·비교 조건·평가·행동 규칙을 한 파일에 담고, 웹과 CLI가 같은 형식으로 읽습니다. 이 가이드는 앱 1.4.0의 [공통 스키마](../src/shared/schema.ts)와 [공간 스키마](../src/shared/spatial-schema.ts)를 기준으로 합니다.

바로 편집하려면 [완전한 작성 예제](../examples/authoring-starter.json)를 복사하세요. 자연어로 작성하려면 [요구사항 양식](#요구사항을-정리하는-양식)을 채우고 [변환 프롬프트](#복사해서-사용하는-변환-프롬프트)와 함께 AI에게 전달하세요. 생성된 JSON은 마지막의 [검증과 실행](#검증과-실행) 절차로 확인합니다.

AI 행동 결과·가상 시간·장소 이동·선택형 사건의 동작은 [세계 엔진·분산 공간](world-engine.md)에 있습니다. 설정 필드는 이 문서에서 설명하며 [단일 공간](../examples/ai-world-engine.json)과 [분산 공간](../examples/spatial-world.json)의 완전한 예제를 제공합니다.

## 먼저 구분할 설정

실험 파일은 무엇을 비교할지 정의합니다. 어떤 실행기를 사용할지는 그 파일을 보내는 서버가 정합니다.

| 항목 | 설정 위치 | 예시 |
|---|---|---|
| 세계관·NPC·모델·추론·전달·평가 | 실험 JSON | `scenario`, `variants`, `evaluation` |
| Codex CLI 또는 OpenAI API | 서버 실행 옵션 | `serve --adapter codex`, `npm run start:openai` |
| API 키 | 페이지의 API 키 설정 우선, 없으면 서버 환경 변수·로컬 `.env` | 개인 키는 해당 브라우저의 새 실험에 적용. 서버 키는 `OPENAI_API_KEY` |
| API 호출당 출력 한도 | 서버 환경 변수 | `OPENAI_MAX_OUTPUT_TOKENS` |
| DB·통합 기록 저장 위치 | 서버 실행 옵션·환경 변수 | `--data`, `NPC_LAB_HISTORY_ROOTS` |
| 토큰·시간 수집 | 엔진이 자동 수행 | 별도 활성화 필드 없음 |

실험 JSON에 `apiKey`, `adapter`, `baseURL`, `max_tokens`, `temperature`, `tokenBudget`를 넣어도 해당 기능이 설정되지 않습니다. 현재 지원하는 실험 필드가 아닙니다. 특히 키를 파일이나 변환 요청에 넣지 마세요. 두 실행기를 비교하려면 동일한 설정을 CLI 서버와 API 서버에 각각 보내고 통합 화면에서 비교합니다. 한 실험의 조건마다 실행기를 바꾸는 기능은 없습니다.

## 전체 구조와 묶음 수

```text
ExperimentSpec
  schemaVersion, name
  scenario
    id, name, world, situation, defaults
    characters[]
    environment                    사전 규칙, 선택 사항
    worldEngineInstructions        AI 진행 규칙, 선택 사항
    spatial                        분산 공간 지도·시작 위치·채널
  variants[]                       비교할 조건을 각각 명시
  repetitions, maxUtterances
  concurrentRuns, maxConcurrentCalls, timeoutMs
  evaluation
  director
  worldEngine                      AI 환경 사용 시 필요
  eventGenerator                   상황 발생 사용 시 필요
  scheduledEvents[]
```

**묶음 수 = `variants.length × repetitions`**입니다. NPC 수는 `scenario.characters.length`이며 `npcCount`라는 별도 필드는 없습니다. 각 묶음은 같은 시나리오로 시작하되 NPC 세션과 대화 기록을 공유하지 않습니다.

예를 들어 NPC 6명, 4조건, 조건별 2회, `maxUtterances: 120`이면 8묶음을 만들고 묶음마다 전체 NPC를 합쳐 최대 120발화를 진행합니다. 1인당 120발화가 아닙니다. 단순 순번제에서 반응 우선·분산 진행 없이 120회를 마치면 각 NPC는 20차례를 갖습니다. 진행자·AI 반응 우선·분산 공간에서는 인물별 횟수가 달라질 수 있습니다.

공개 발화 수에는 대사 없이 행동만 출력한 차례도 포함됩니다. `maxUtterances: 120`이 120개의 비어 있지 않은 대사를 보장하지는 않습니다. 현재 설정에는 대사 필수 여부를 강제하는 전용 필드가 없습니다. 수신 확인, 환경 결과, 수동 사건, 평가, 진행자 호출은 공개 발화 수에 포함하지 않습니다.

### 최상위 필드

‘필수’는 JSON에 키가 있어야 한다는 뜻입니다. 기본값이 있는 필드는 생략하면 스키마가 채웁니다. AI 변환 결과에는 기본값도 명시하는 편이 검토하기 쉽습니다.

| 필드 | 필수 또는 생략 시 값 | 의미와 범위 |
|---|---|---|
| `schemaVersion` | 필수 | 숫자 `1` |
| `name` | 필수 | 비어 있지 않은 실험 이름. 묶음 이름에 조건명·반복 번호가 추가됨 |
| `scenario` | 필수 | 시나리오 객체 |
| `variants` | 필수 | 1~100개 조건. `id` 중복 불가 |
| `repetitions` | `1` | 조건별 반복 횟수, 정수 1~100 |
| `maxUtterances` | `60` | 묶음당 최대 공개 발화 수, 정수 1~100000 |
| `concurrentRuns` | `2` | 이 실험에서 동시에 진행할 묶음 수, 정수 1~16 |
| `maxConcurrentCalls` | `2` | 동시 모델 호출 상한, 정수 1~32 |
| `timeoutMs` | `300000` | 모델 요청 한 번의 제한 시간, 정수 1000~3600000밀리초. 전체 실험 제한 시간이 아님 |
| `evaluation` | 필수 | 평가 객체. 꺼도 객체와 모델·추론 필드는 필요 |
| `director` | 필수 | 진행자용 `{ "model": "...", "effort": "..." }`. 순번제여도 객체는 필요 |
| `worldEngine` | 선택 | `{model, effort}`. ai/ai_spatial 조건이 있으면 필수 |
| `eventGenerator` | 선택 | 상황 발생 모델·빈도·범위. eventGeneration 조건이 있으면 필수 |
| `scheduledEvents` | `[]` | 발화 번호별 사건. 선택 audience로 관찰 범위 지정 |

전체 묶음은 최대 500개입니다. 100조건 × 100반복처럼 각 필드의 범위는 맞아도 곱이 500을 넘으면 거부됩니다. `concurrentRuns`는 생성 개수를 줄이지 않고 실행 순서만 제한합니다. 같은 서버에서 여러 실험을 돌리면 전체 묶음 상한과 활성 실험들의 호출 한도도 함께 적용됩니다.

스키마 기본 발화 수는 60이지만 API 서버의 ‘새 예제’는 짧은 확인용 값으로 6발화·평가 간격 6·동시 묶음과 호출 1을 제안합니다. 분산 공간 예제 불러오기는 별도의 60차례·2조건 구성을 사용합니다. 불러온 JSON의 값을 자동으로 6차례로 줄이지는 않습니다.

## 세계관과 시작 상황

| `scenario` 필드 | 작성 내용 |
|---|---|
| `id` | 시나리오 식별자 |
| `name` | 사람이 읽는 이름 |
| `world` | 모든 NPC가 받는 공개 세계 설정. 비어 있지 않은 문자열 |
| `situation` | 대화 시작 시점의 상황. 비어 있지 않은 문자열 |
| `defaults` | NPC 모델·추론의 기본값 |
| `characters` | 2~30명의 캐릭터. 캐릭터 ID 중복 불가 |
| `environment` | rules 모드의 행동·결과·목표 규칙. 생략 가능 |
| `worldEngineInstructions` | AI 세계 엔진에 주는 추가 장면 규칙 문자열. 생략 가능 |
| `spatial` | ai_spatial의 장소·통로·시작 위치·채널. 해당 모드이면 필수 |

시나리오·캐릭터·조건·행동·목표 ID와 상태 키에는 **영문 대소문자, 숫자, `_`, `-`만** 쓰고 길이는 1~100자로 합니다. 표시 이름과 본문에는 한국어를 쓸 수 있습니다. `hestia-plan`, `orb-jian`, `planApproved`는 가능하고 `연지안`, `plan approved`, `npc.1`은 ID로 사용할 수 없습니다.

`world`에는 확정된 사실, 금지된 능력·권한, 자원 제약, 아직 모르는 사실을 구분해 씁니다. `situation`에는 지금 누가 어디에 있고 무엇이 아직 실행되지 않았는지 적습니다. 미래의 성공 결과를 시작 상황에 이미 일어난 일처럼 넣지 마세요.

예를 들어 ‘진단을 논의한다’와 ‘진단을 실행해 장치가 정상임을 확인했다’는 다른 설정입니다. 실제 결과가 원본에 없다면 성공·실패를 임의로 정하지 말고, 논의만 할지 작성자가 결과 규칙을 추가할지 결정해야 합니다.

`world`, `situation`, 참가자 ID·이름은 모든 NPC에게 제공됩니다. 특정 NPC만 아는 정보는 그 NPC의 `memories`, `knowledge`, `goals` 등에 둡니다. 비밀을 `world`에 적으면 이미 공개 정보가 됩니다. 본인 캐릭터 객체는 본인 세션에만 전달되지만 NPC가 대화에서 그 내용을 밝히면 해당 발언의 수신 대상에게 전달됩니다. 분산 공간의 initialSituation은 시작 장소의 NPC만 받지만 공통 world/situation은 모두가 받습니다.

## 캐릭터 작성

이름과 ID만으로 시작할 수 있습니다. 표현하고 싶은 차이가 있으면 ‘기다려도 불편한 자리는 피한다’처럼 선택에 영향을 주는 단서 하나를 적으세요. 특정 반말이나 존댓말, 관계, 아는 사실이 중요하면 해당 필드에 직접 적습니다. 같은 이유를 반복하지 않기, 휴식 중에 임무를 꺼내지 않기 같은 공통 지침은 엔진이 제공합니다.

| 캐릭터 필드 | 필수 여부 | 역할 |
|---|---|---|
| `id` | 필수 | 모든 관계·행동 수행자에서 참조할 ID |
| `name` | 필수 | 표시 이름, 1~100자 |
| `identity` | 생략 시 `""` | 직업·역할·지위·신체적 제약 등 정체성 |
| `personality` | 생략 시 `""` | 성격, 갈등에 반응하는 방식 |
| `values` | 생략 시 `""` | 우선하는 가치와 양보할 수 없는 기준 |
| `goals` | 생략 시 `""` | 캐릭터가 원하는 일. 자유 서술 문자열 |
| `relationships` | 생략 시 `""` | 다른 참가자를 어떻게 알고 대하는지 |
| `memories` | 생략 시 `""` | 본인이 기억하는 과거 사실과 정보의 출처 |
| `knowledge` | 생략 시 `""` | 알고 있는 사실·전문 지식·권한 범위 |
| `unknowns` | 생략 시 `""` | 모르는 사실·확정할 수 없는 판단 |
| `speechStyle` | 생략 시 `""` | 존댓말·반말, 문장 길이, 어휘, 감정 표현 |
| `exampleDialogue` | 생략 시 `""` | 말투를 보여 주는 예시 대사. 실제 대화 기록이 아님 |
| `behaviors` | 생략 시 `""` | 관찰 가능한 행동 습관과 반응 |
| `taboos` | 생략 시 `""` | 하지 않는 말·행동·거짓 확정 |
| `model`, `effort` | 각각 선택 사항 | 이 NPC의 모델·추론을 조건과 기본값보다 우선 적용 |

프로필 본문은 최대 100000자의 문자열입니다. 여러 항목은 문자열 안에서 `\n`으로 나눌 수 있습니다. 새 실행은 각 인물의 첫 발화와 함께 관심의 방향과 말의 박자를 기억합니다. 프로필이 전부 비어 있으면 참가자 순서로 가벼운 표현 차이를 부여합니다. 개인사·능력·인간관계는 작성자가 지정합니다.

### 자연스러운 말투와 반복을 구분하는 방법

`speechStyle`에는 어조와 표현 범위를, `exampleDialogue`에는 서로 다른 상황의 짧은 예문을 적습니다. ‘매번 출처와 상태를 구분해 보고한다’처럼 모든 발화의 형식을 고정하면 그 문구 자체가 반복될 수 있습니다. 행동 습관도 매 차례 실행해야 하는 의무처럼 적지 않는 편이 좋습니다.

```json
{
  "speechStyle": "친근한 반말. 짧고 구체적으로 제안한다. 상대가 걱정하면 가볍게 안심시키되 모르는 결과를 장담하지 않는다.",
  "exampleDialogue": "내가 옮길게. 어디에 두면 돼?\n응, 그건 아직 모르겠네. 확인할 수 있는 것부터 보자.",
  "behaviors": "듣는 동안 고개를 기울인다. 물건을 다룰 때는 손을 조심스럽게 움직인다. 같은 동작을 매 발화 되풀이할 필요는 없다."
}
```

이 코드는 캐릭터의 일부 필드만 보여 주는 예시입니다. 원본 캐릭터가 업무식 존댓말을 쓰도록 설계되어 있다면 자연스럽게 만들겠다는 이유로 반말이나 새로운 유머 취향을 추가하지 마세요. 원본 설정의 반복 원인과 모델이 지시를 따르지 못한 문제는 따로 판단합니다.

## 모델과 비교 조건

### 모델과 추론의 적용 순서

각 항목을 따로 계산합니다.

```text
최종 model  = 캐릭터.model  → 조건.model  → scenario.defaults.model
최종 effort = 캐릭터.effort → 조건.effort → scenario.defaults.effort
```

캐릭터에서 `model`만 고정하면 추론은 조건에서 바뀔 수 있습니다. 조건에서 `model`만 바꾸면 기본 추론 강도가 새 모델에서도 지원되는지 확인해야 합니다. 모든 NPC의 모델을 조건별로 바꾸려면 기존 캐릭터의 모델 재정의가 비교를 막고 있지 않은지 확인하세요.

`evaluation`, `director`, `worldEngine`, `eventGenerator`의 model/effort는 별도 값이며 NPC 우선순위를 상속하지 않습니다. 같은 비교 안에서 평가 모델을 고정하려면 `evaluation`을 한 쌍으로 유지합니다. 조건별 평가 모델을 달리하려면 실험 파일을 나누어야 합니다.

모델 ID와 강도는 실행할 서버의 `models` 결과를 사용합니다. ‘terra-low’라는 문자열을 `model` 하나에 넣지 말고 모델 ID와 강도를 분리하세요. 아래 예제의 `gpt-6.1-terra` / `low`도 실행 서버에서 사용 가능한지 검증해야 합니다. 강도는 모든 모델에서 공통인 고정 목록이 아니며, 이 앱은 `ultra`를 허용하지 않습니다.

### 조건 필드와 전달 방식

| `variants[]` 필드 | 값과 의미 |
|---|---|
| `id`, `label` | 필수. 조건 ID와 표시 이름 |
| `model`, `effort` | 선택 사항. NPC 모델·추론 재정의 |
| `memoryMode` | `initial_only` 기본 / `reinject_on_speech` |
| `deliveryMode` | `batched_on_turn` 기본 / `per_utterance` |
| `turnPolicy` | `round_robin` 기본 / `director` |
| `dialoguePromptVersion` | 선택 사항. `npc-dialogue/1`~`/10`. 현재 기본값은 `/5` |
| `characterPerformanceVersion` | 선택 사항. 새 실행 기본값 `character-performance/2`, 초기 비교판 `character-performance/1`, 엔진 보조를 끄는 `off`. 버전 도입 전 저장된 실행은 기존 방식으로 재개 |
| `worldPromptVersion` | 선택 사항. `npc-world/1`~`/6`. 단일 공간 `ai`에서만 사용. 생략하면 새 실행 생성 시 현재 기본값 `/6`을 고정 |
| `stopOnSilence` | 선택 불리언. 기본 꺼짐. `off`에서 모두 조용하고 미적용 예정 사건이 없으면 종료 |
| `environmentMode` | `off`, `rules`, `ai`, `ai_spatial`. 생략 시 활성 environment가 있으면 rules, 없으면 off |
| `eventGeneration` | 선택 불리언. 생략은 꺼짐. true는 ai/ai_spatial과 eventGenerator 필요 |

`batched_on_turn`은 다른 NPC의 발언을 수신함에 쌓았다가 자기 차례에 아직 받지 않은 내용을 순서대로 전달합니다. 별도 수신 모델 호출은 없고 종료 시 미처리 수신함이 남을 수 있습니다.

프롬프트의 실제 선택은 생성된 실행의 `variant`와 호출 메타데이터에서 확인합니다. 원본 spec은 입력 당시 값을 보존합니다. 이미 생성된 세션의 지침은 재개할 때 바꾸지 않습니다. 세계 버전 필드가 없던 실행에서 새로 만드는 세계 세션은 이전 기본값 `/2`를 사용합니다. 그보다 오래된 임의 지침을 정확히 복원한다는 뜻은 아닙니다. 변경 이유와 검증은 [프롬프트 관리](dialogue-prompts.md)에 있습니다.

`per_utterance`는 발화마다 실제 관찰 대상 NPC가 같은 세션·모델·추론으로 수신 확인 호출을 수행합니다. 필요한 확인을 모두 처리한 뒤 다음 단계가 시작됩니다. 분산 공간에서는 위치·통신 방식에 따라 수신 대상이 줄고, 혼자 행동은 수신 호출이 없을 수 있습니다. 수신 출력은 공개 대사에 섞이지 않습니다.

`initial_only`는 초기 설정을 준 동일 세션을 이어 갑니다. `reinject_on_speech`는 본인의 공개 발화 요청에 원본 설정을 추가로 상기시킵니다. 수신 확인에는 추가 상기를 넣지 않습니다. API 실행도 역할 지시문을 매 요청에 설정하므로 `initial_only`가 ‘첫 요청 이후 캐릭터 지시문을 완전히 제거한다’는 뜻은 아닙니다. 실행기별 세션 차이는 [API 안내](openai-api.md)에 있습니다.

단일 공간의 `round_robin`은 캐릭터 배열 순서를 따릅니다. AI 환경의 반응 대상은 우선할 수 있습니다. 분산 공간은 장소별 선택 가능한 NPC 중 오래 선택되지 않은 순서이며 최초 동률은 캐릭터 배열 순서입니다. `director`는 후보와 발생한 기록으로 다음 화자를 고르며 연속 선택·장기 배제를 제한합니다. 이 제한 수치를 바꾸는 JSON 필드는 없습니다.

진행자는 매 선택마다 독립 세션에서 최근 관찰 최대 8개와 화자별 대기 순서를 참고합니다. 전체 대화나 이전 진행자 호출을 누적하지 않으며 긴 대사·행동에도 길이 제한을 적용합니다. `director` 설정은 기존처럼 `model`, `effort`만 사용합니다. 상세 한도와 복구 방식은 [AI 진행자의 입력 범위](running-experiments.md#ai-진행자의-입력-범위)를 참고하세요.

화면의 **AI 진행자 설정**은 `turnPolicy: "director"`인 조건이 하나라도 있을 때 실행 조건 목록 바로 아래에 표시됩니다. 해당 조건들이 하나의 진행자 모델·추론 설정을 공유합니다. 모두 순번제로 바꾸면 숨겨지며, 다시 선택하면 기존 값이 복원됩니다. 독립 평가 사용 여부와는 관계없습니다.

### 비교 조합을 명시하는 예시

앱은 JSON에 적힌 조건만 실행합니다. `models`, `efforts` 배열이나 곱셈 설정을 자동으로 펼치는 JSON 규격은 없습니다. 다음은 한 모델에서 기억 2종 × 전달 2종을 비교하는 `variants` 값입니다.

```json
[
  { "id": "initial-batch", "label": "초기 설정 모아 전달", "memoryMode": "initial_only", "deliveryMode": "batched_on_turn", "turnPolicy": "round_robin" },
  { "id": "initial-each", "label": "초기 설정 매 발화", "memoryMode": "initial_only", "deliveryMode": "per_utterance", "turnPolicy": "round_robin" },
  { "id": "remind-batch", "label": "설정 재주입 모아 전달", "memoryMode": "reinject_on_speech", "deliveryMode": "batched_on_turn", "turnPolicy": "round_robin" },
  { "id": "remind-each", "label": "설정 재주입 매 발화", "memoryMode": "reinject_on_speech", "deliveryMode": "per_utterance", "turnPolicy": "round_robin" }
]
```

여기에 모델 2종과 추론 2종까지 곱하면 16조건입니다. 각 조건에 해당 `model`, `effort`를 명시하고 ID를 모두 다르게 만듭니다. 전체 모델에 같은 강도가 지원되는지 확인한 후 조합을 생성하세요.

## AI 환경·장소·상황 발생 설정

AI 환경에는 `worldEngine: {"model":"서버의 모델 ID","effort":"지원 강도"}`를 지정합니다. `scenario.worldEngineInstructions`는 추가 장면 규칙 문자열입니다. 비공개 기억·목표·성격을 여기에 복사하지 않습니다. 기본 단일 공간은 `ai`, 분산 공간은 `ai_spatial`입니다.

### scenario.spatial

| 배열 | 항목과 범위 |
|---|---|
| locations | 2~100개. id, name(1~100자), description(문자열), initialSituation(기본 빈 문자열) |
| connections | 기본 [], 최대 500개. id, from, to, bidirectional(기본 true), description(기본 빈 문자열) |
| initialPositions | 모든 NPC마다 정확히 하나의 {npcId, locationId}. 2~30개 |
| channels | 기본 [], 최대 100개. id, name(1~100자), memberNpcIds(2~30명), description(기본 빈 문자열) |

ID는 각각의 종류 안에서 고유해야 합니다. 통로의 from/to는 선언된 서로 다른 장소이며, 시작 위치·채널은 실제 참가자 ID를 참조합니다. 채널 참가자 중복은 금지합니다. 장소·통로 정보가 원본에 없다면 작성자에게 확인해야 하며 실행 중 새 장소를 자동 생성하지 않습니다.

다음은 spatial **필드만의 발췌**입니다. eun/haneul은 scenario.characters에 선언되어 있어야 합니다.

```json
{
  "locations": [
    {"id": "desk", "name": "접수대", "description": "책을 인계하는 곳.", "initialSituation": "책 한 권이 놓여 있다."},
    {"id": "lounge", "name": "휴게실", "description": "대기하는 곳.", "initialSituation": ""}
  ],
  "connections": [
    {"id": "hall", "from": "desk", "to": "lounge", "bidirectional": true, "description": "두 장소 사이의 짧은 통로"}
  ],
  "initialPositions": [
    {"npcId": "eun", "locationId": "desk"},
    {"npcId": "haneul", "locationId": "lounge"}
  ],
  "channels": [
    {"id": "radio", "name": "업무 무전", "memberNpcIds": ["eun", "haneul"], "description": "대사만 전달하는 채널"}
  ]
}
```

공통 world/situation은 모두에게 제공됩니다. 처음 한 장소의 NPC만 알아야 하는 장면은 그 장소의 initialSituation에 둡니다. 이동·긴 행동·관찰 범위는 [세계 엔진 안내](world-engine.md)처럼 실행 중 결정하며 `worldState`, `spatialIntent`, `perception`을 실험 설정에 직접 넣지 않습니다.

### eventGenerator

| 필드 | 필수·기본값·범위 |
|---|---|
| model, effort | 필수. 별도 상황 제안 모델·추론 |
| intervalSeconds | 기본 30. 0 초과~31536000의 가상 초 |
| minGapSeconds | 기본 60. 0~31536000의 가상 초 |
| maxChecks | 기본 30. 정수 1~10000. 침묵 포함 정상 처리 검토 수 |
| maxProposals | 기본 10. 정수 1~1000. 채택·거절을 합친 제안 수 |
| maxSeverity | low/medium/high, 기본 medium |
| allowedEvents | 필수 문자열. 상황 발생을 사용하는 조건이 하나라도 있으면 공백 이외의 내용이 필요. 모든 조건이 꺼져 있으면 빈 문자열 허용 |
| forbiddenEvents | 기본 빈 문자열. 금지 사건 |

eventGenerator 객체만 넣어서는 실행되지 않습니다. 사용할 조건에 `eventGeneration:true`를 지정합니다. 반대로 true인데 객체가 없거나 환경이 off/rules이면 거부합니다. 같은 실험의 조건들은 공통 생성 모델·빈도를 사용하며 조건별로 켬/끔을 비교할 수 있습니다.

화면에서 상황 발생을 모두 꺼도 입력한 공통 설정은 보존합니다. 사건 범위를 비워 둔 채 켰다가 꺼도 저장·검증할 수 있으며, 다시 사용할 때는 범위를 작성해야 합니다. 공백만 입력한 값은 사용 중인 조건이 있으면 거부합니다. 꺼둔 설정이라도 모델·추론·숫자 등 다른 필드의 형식은 유효해야 합니다.

조건 이름을 포함한 행 전체를 클릭하거나 체크박스에 초점을 두고 Space 키를 눌러 켬/끔을 바꿀 수 있습니다. 체크박스는 20px 고정 크기로 글 옆에 정렬되며, 사용 중·꺼짐·사용 불가 상태를 표시합니다. 모든 조건을 끄면 공통 상세 설정이 접힙니다. 사용할 때 사건 범위가 비어 있으면 해당 입력란 옆에 안내가 표시됩니다.

상황 AI의 제안은 세계 엔진 검토를 통과해야 적용됩니다. 실패·재시도는 별도 호출이어서 실제 호출 수가 maxChecks를 넘을 수 있습니다. 새로운 핵심 설정·NPC 자발적 행동·내면을 대신 정하는 사건은 허용하지 않습니다.

## 행동 결과와 목표 달성

### 서술 목표와 판정 목표

`characters[].goals`는 NPC의 동기입니다. ‘책 인계를 마친다’고 쓰는 것만으로 화면에 목표 달성 판정이 생기지는 않습니다. 자동 판정을 원하면 **`scenario.environment.goals`의 상태 조건**을 정의해야 합니다.

rules 이외의 환경 방식이거나 환경 규칙을 생략하거나 `enabled: false`로 두면 구조화 목표 지표는 ‘목표 미정의’입니다. 미달성 0%와 구분합니다. 환경 설정을 제공한다면 꺼 놓더라도 규칙 자체의 형식과 ID·자료형은 유효해야 합니다.

### 환경 필드

| 필드 | 내용 |
|---|---|
| `enabled` | 기본 `true`. 규칙 사용 여부 |
| `stopOnGoals` | 기본 `true`. 모든 목표가 현재 충족되면 조기 종료 |
| `initialState` | 상태 키와 초기값의 객체. 값은 문자열·유한 숫자·불리언만 가능 |
| `actions` | 1~100개 행동 규칙 |
| `goals` | 1~50개 판정 목표 |

`initialState`에는 나중에 사용할 키를 모두 선언합니다. 배열·중첩 객체·`null`은 상태 값으로 지원하지 않습니다. 상태 문자열은 최대 1000자입니다. `stopOnGoals: false`는 목표를 판정하면서도 발화 한도까지 대화를 계속하게 합니다. 정확히 120차례의 장기 관찰이 목적이라면 이 값을 확인하세요. 오류·중단·일시정지까지 없어진다는 뜻은 아닙니다.

행동은 다음 필드를 갖습니다.

| 행동 필드 | 내용 |
|---|---|
| `id`, `label` | 행동 ID와 의미 |
| `actorIds` | 수행할 수 있는 캐릭터 ID 목록, 최소 1명 |
| `conditions` | 모두 참이어야 하는 선행 조건. 생략 시 `[]` |
| `effects` | 성공 후 상태에 대입할 값. 최소 한 키 필요 |
| `result` | 작성자가 미리 정한 공개 결과문. 비어 있지 않은 문자열 |
| `once` | 기본 `true`. 한 번 성공한 뒤 재사용 불가 |

조건은 `{ "key": "상태키", "op": "eq", "value": 값 }` 형식입니다. `op` 생략 시 `eq`이며 `eq`는 같음, `neq`는 다름, `gte`는 숫자 이상, `lte`는 숫자 이하입니다. 조건 배열은 AND이고 OR·괄호식·임의 코드는 지원하지 않습니다.

```json
{
  "id": "place_book",
  "label": "확인된 책을 반납대에 내려놓는다",
  "actorIds": ["haneul"],
  "conditions": [
    { "key": "coverChecked", "op": "eq", "value": true },
    { "key": "bookOnDesk", "op": "eq", "value": false }
  ],
  "effects": { "bookOnDesk": true },
  "result": "하늘이 책 한 권을 반납대에 내려놓았다. 인계 기록은 아직 완료되지 않았다.",
  "once": true
}
```

이 행동은 완전한 예제의 `initialState`와 NPC 목록 안에서 사용합니다. 효과는 기존 키의 자료형을 유지해야 합니다. `effects: { "power": "power - 4" }`는 연산이 아니라 문자열 대입입니다. 산술식이나 증감 연산자는 없습니다. 필요한 상태별 행동과 상수 결과를 작성하거나, 더 복잡한 자원 엔진이 필요하면 코드를 확장해야 합니다.

`once: false`여도 조건이 맞고 효과 중 적어도 하나가 현재 값과 달라야 실행 후보가 됩니다. 같은 값을 계속 대입하는 행동은 반복 실행 후보가 되지 않습니다. NPC 한 차례에는 행동 ID 하나만 요청할 수 있습니다.

목표는 `{ "id", "label", "conditions" }`이며 조건이 최소 1개 필요합니다. 행동 ID끼리 중복할 수 없고 목표 ID끼리도 중복할 수 없습니다. 한 인물의 동의를 다른 인물이 대신하게 하지 않으려면 인물별 상태 키와 `actorIds`가 제한된 개별 동의 행동을 만드세요.

### 세계관을 추가하지 않으면서 진행시키는 설계

1. 세계의 불변 사실과 지금 변할 수 있는 장면 상태를 구분합니다.
2. 각 단계의 수행자·선행 조건·효과·관찰 결과를 원본 설정 또는 작성자가 허용한 범위에서 정합니다.
3. NPC는 행동을 **시도**하고, 엔진은 정해진 결과를 공개 사건으로 확정합니다.
4. 목표까지 도달 가능한 행동 순서가 있는지 직접 따라가 봅니다.

‘진단을 시도할 수 있지만 결과를 알 방법은 없다’는 설정으로 실제 진단 완료까지 요구하면 확인·준비 대화가 반복될 수 있습니다. 결과가 미정이라면 논의·승인 자체를 목표로 하거나, 작성자가 관찰 결과를 추가로 정해야 합니다. 변환 AI가 임의로 ‘진단 정상’을 보충하게 해서는 안 됩니다.

**환경의 초기 상태·행동·결과문·목표는 모든 NPC에게 공개됩니다.** 결과가 실행 전부터 발생한 사실은 아니지만 가능한 결과 규칙 자체를 숨길 수는 없습니다. 비공개 진단 정답이나 다른 NPC의 비밀을 환경 규칙에 넣는 방식은 지원하지 않습니다.

행동 성공은 공개 발화 다음의 `환경 결과` 사건으로 기록됩니다. NPC의 자유 서술, 예약 사건, 수동 상황 투입은 구조화 상태를 직접 바꾸지 않습니다. 목표 판정은 엔진의 상태 기록을 사용합니다.

## 평가와 반복률

화면에서 **주기 평가와 종료 평가 사용**을 켰을 때만 설명과 평가 모델·추론 강도·간격·맥락 한도가 펼쳐집니다. 끄면 상세 설정이 접히며 입력값은 유지됩니다. 반복률 계측은 별도로 계속 표시됩니다. 평가 체크 행 전체를 클릭하거나 키보드 Space로 전환할 수 있습니다. 이 UI 동작은 `evaluation.enabled`만 바꾸며 평가 기준이나 진행 방식은 바꾸지 않습니다.

| `evaluation` 필드 | 필수 또는 기본값 | 의미 |
|---|---|---|
| `enabled` | `true` | AI 평가 사용 여부 |
| `interval` | `10` | 정수 1 이상. 공개 발화 몇 개마다 새 구간을 평가할지 |
| `model`, `effort` | 필수 | 독립 평가 세션 모델과 강도 |
| `contextCharacters` | `100000` | 정수 1000~500000. 평가용 공개 기록의 문자 길이 기준 |
| `repetitionWindow` | `12` | 정수 1~100. 이전 몇 개의 전체 공개 발화에서 같은 화자의 발언을 찾을지 |
| `repetitionThreshold` | `0.72` | 0.1~1. 어휘 유사도 판정 기준 |
| `repetitionMinChars` | `20` | 정수 3~1000. 정규화한 대사가 이 길이 이상일 때만 비교 |

종료 시에는 마지막 미평가 구간도 평가합니다. `maxUtterances: 120`, 간격 10이면 정상 경로에서 12구간입니다. AI 평가 기준은 성격·가치관, 말투, 행동, 기억, 지식 범위, 세계관 모순, 세계관 확대, 의미 반복, 목표 진행 정체의 9종으로 고정되어 있습니다. `evaluation.categories`나 `customPrompt` 필드로 평가 기준을 교체할 수는 없습니다.

`contextCharacters`는 모델의 토큰 한도가 아니라 평가 요청의 공개 기록 JSON 문자 한도입니다. 대상 구간 이전의 맥락부터 덜어내며 대상 발화와 그 환경 결과는 보존합니다. 대상 구간만으로 한도를 넘으면 구간을 나누어 평가하므로 평가 호출 수가 늘어날 수 있습니다. 발화 하나와 그 결과만으로도 초과하면 해당 구간은 호출 없이 평가 실패·미평가로 기록하고 평가 완료 통계에서 제외합니다. 설정·캐릭터·지시문은 별도로 포함되므로 전체 요청은 이 수치를 넘을 수 있습니다. 제외된 이전 맥락은 `contextTruncated`로 표시됩니다.

어휘 반복률은 같은 화자의 정규화한 대사에 문자 3-gram Dice 유사도를 적용합니다. 행동문과 사건은 제외하며 비교 가능한 이전 발언이 없는 경우 분모에 넣지 않습니다. 분모가 없으면 0% 대신 `null`입니다. 뜻은 같아도 표현이 크게 다르면 놓칠 수 있으므로 AI의 `repetition` 지적률과 별도로 봅니다. 어휘 반복률과 구조화 목표는 `evaluation.enabled: false`여도 계산할 수 있지만, AI 의미 반복 지적과 다른 AI 평가는 생성되지 않습니다.

목표 미달만으로 `goal_stagnation`을 자동 지적하지 않습니다. 가능한 행동이 있었는데 여러 차례 유보했다는 공개 근거를 평가합니다. AI 지적은 사람이 확정·기각할 수 있으며, 평가 내용은 NPC에게 전달되지 않습니다.

## 예약 사건과 호출 수

```json
[
  { "afterUtterance": 0, "text": "대화 시작 전 공개 사건을 여기에 작성한다." },
  { "afterUtterance": 6, "text": "여섯 번째 공개 발화 후 전달할 사건을 작성한다." }
]
```

이 코드는 `scheduledEvents`의 형식 예시입니다. `afterUtterance`는 0 이상의 정수이며 시간이나 NPC별 횟수가 아닙니다. 0이면 첫 발화 전입니다. 같은 번호의 사건은 배열 순서대로 처리하므로 작성 시 번호 순으로 정리하세요. 조기 종료나 중단으로 해당 번호에 도달하지 못하면 사건은 실행되지 않습니다. 예약 사건은 관찰 서술을 전달하며 rules의 목표 상태를 직접 변경하지 않습니다. AI 환경에서는 이후 엔진 처리의 입력에 포함됩니다.

`audience`는 선택 객체입니다. `{ "scope": "locations", "locationIds": ["lounge"], "npcIds": [] }`처럼 두 배열을 포함합니다. locations는 장소 배열만, npcs는 NPC 배열만 채우고 all/none은 둘 다 비웁니다. 미지정은 전체입니다. 장소 범위 예약은 실험의 모든 조건이 ai_spatial이어야 하며 알 수 없는 ID·중복은 거부합니다.

아래 공식은 **단일 공간에서 모두가 관찰하며 AI 환경을 끈 경우**의 참고입니다. NPC 수 N, 선택 수 S, 전체 관찰 사건 수 E이고 재시도·실패가 없습니다. E에는 규칙 결과·예약·수동 사건이 포함됩니다.

| 종류 | 모아 전달 | 매 발화 전달 |
|---|---|---|
| 공개 발화 생성 | S | S |
| 별도 수신 확인 | 0 | `S × (N - 1) + E × N` |
| AI 진행자 | 순번제는 0, 진행자 방식은 일반적으로 `max(0, S - 1)` | 동일 |
| AI 평가 | 켜져 있으면 종료까지 보통 `ceil(S / interval)` | 동일 |

예를 들어 NPC 3명·6발화·사건 없음·순번제·평가 끔이면 모아 전달 6회, 매 발화 전달 18회입니다. 완전한 작성 예제는 환경 사건과 평가가 켜져 있으므로 6회·18회로 끝나는 예제가 아닙니다. 각 호출의 입력 길이·세션 문맥·모델이 달라 호출 수와 토큰·시간 차이가 같은 비율로 움직이지는 않습니다. `maxConcurrentCalls`도 전체 호출 수를 줄이지 않습니다. AI 환경은 environment, 선택형 상황은 event_generation 및 검토 호출이 추가됩니다. 분산 공간·범위 지정 사건은 실제 수신 대상만 호출하므로 위 수신 공식이 적용되지 않습니다. 공동 처리와 호출별 계측은 [데이터 문서](data-and-evaluation.md)를 참고하세요.

## 완전한 예제에서 시작하기

[authoring-starter.json](../examples/authoring-starter.json)은 은·하늘·율 3명이 책을 확인·인계·기록하는 예제입니다. 모델은 Luna low, 전달 방식은 2조건, 반복은 1회, 묶음당 6발화, 3발화마다 평가입니다. 모든 목표를 달성해도 한도까지 관찰하도록 `stopOnGoals: false`로 두었습니다. 세계관과 규칙은 이 예제용으로 작성한 것이며 헤스티아 설정을 바꾼 파일이 아닙니다.

```powershell
Copy-Item examples/authoring-starter.json examples/my-experiment.json
```

먼저 세계관·참가자·말투를 편집하고, 모델 목록에 맞춰 `scenario.defaults`, 조건별 모델, `evaluation`, `director`를 확인합니다. 장기 테스트는 `maxUtterances`를 늘리고, 전달 방식 하나만 원하면 `variants`에서 다른 조건을 제거합니다. 구조화 진행을 사용하지 않을 때는 `scenario.environment`를 생략합니다.

다른 시작점은 다음과 같습니다.

- [quick-check.json](../examples/quick-check.json): 환경 규칙 없이 두 전달 방식을 각 6발화로 비교.
- [delivery-comparison.json](../examples/delivery-comparison.json): 안개항의 사전 정의 행동·목표를 포함한 두 전달 방식.
- [memory-delivery-matrix.json](../examples/memory-delivery-matrix.json): 기억 2종 × 전달 2종.
- [헤스티아 6인 원본](../assets/npc-canon/experiments/orison-ensemble.json): 기존 세계관과 비공개 프로필을 유지해 조건을 바꾸는 출발점. 원본의 행동·목표 규칙 유무와 발화 한도를 따로 확인.

## 요구사항을 정리하는 양식

변환 AI에게 원본 파일의 **본문 또는 실제 첨부 파일**을 함께 주세요. ‘헤스티아 6명’이라는 이름만으로는 원래 세계관과 비공개 기억을 복원할 수 없습니다. 다음 양식과 변환 프롬프트를 같은 요청에 붙이면 됩니다.

```text
[실험 목적]
무엇을 비교할지:
성공 여부를 어떤 관찰로 판단할지:

[실행 환경]
실행 경로: Codex CLI / OpenAI API
실행 서버의 models 결과: 여기에 붙이기
전체 기본 모델과 추론 강도:
평가 모델과 추론 강도:
AI 진행자 사용 시 진행자 모델과 추론 강도:
AI 환경 사용 시 세계 엔진 모델과 추론 강도:
상황 발생 사용 시 모델과 추론 강도:

[원본 자료]
세계관 원문 또는 첨부:
대화 시작 상황:
캐릭터 원문 또는 첨부:
참가시킬 캐릭터와 인원:
원본에서 바꾸어도 되는 내용:
반드시 유지할 비공개 정보와 금기:

[비교 조건]
모델 목록:
추론 강도 목록:
기억 방식: 초기 유지 / 발화 전 재주입 / 둘 다
전달 방식: 모아 전달 / 매 발화 전달 / 둘 다
진행 방식: 순번제 / AI 진행자
NPC별 모델·추론 예외:
원하는 조합 전체 또는 제외할 조합:

[실행량]
조건별 반복 횟수:
묶음당 전체 공개 발화 수:
동시 묶음 수:
동시 모델 호출 수:
호출 제한 시간:

[진행과 목표]
환경 방식: off / rules / ai / ai_spatial / 원본 유지
AI 추가 규칙:
분산 공간의 장소·통로·NPC 시작 위치·원격 채널:
상황 발생 켬/끔·가상 시간 빈도·강도·최대 횟수·허용/금지 범위:
공개 초기 상태:
허용 행동별 수행자·선행 조건·효과·관찰 결과:
자동 판정할 목표와 충족 조건:
목표 달성 시 조기 종료 여부:
발화 번호별 예약 사건과 관찰 대상:
미정인 결과를 AI가 새로 설계해도 되는 범위:

[평가]
AI 평가 켬/끔과 간격:
어휘 반복률 창·임계값·최소 문자 수 변경 여부:
그 밖의 요구사항:
```

예를 들어 기존 헤스티아 자료를 유지하고 조건만 바꾸려면 이렇게 덧붙일 수 있습니다.

```text
첨부한 orison-ensemble.json을 원본으로 사용해 줘.
API 서버에서 쓸 설정이며 모델 목록도 아래에 제공한다. API 키는 넣지 않는다.
세계관, 시작 상황, 6명 전원의 프로필은 원문 그대로 유지한다.
NPC는 전원 gpt-6.1-terra / low, 모아 전달, 초기 설정 유지, 순번제다.
조건 하나를 1회, 전체 120발화로 실행하고 동시 묶음·모델 호출은 각각 1이다.
평가는 gpt-6.1-terra / low로 10발화마다 한다.
원본에 없는 환경 행동·진단 결과·예약 사건은 새로 만들지 않는다.
목표 판정 규칙이 원본에 없다면 목표 미정의로 두고 동기 서술은 보존한다.
```

## 복사해서 사용하는 변환 프롬프트

[requirements-to-experiment-json.txt](prompts/requirements-to-experiment-json.txt)를 열어 전체 내용을 복사한 뒤, 위 요구사항 양식·원본 파일 본문·실행 서버의 models 결과를 함께 전달하세요. 이 파일이 **유일한 복사용 프롬프트 원본**입니다. 가이드에 같은 내용을 다시 복제하지 않습니다.

프롬프트에는 schemaVersion 1의 필수 필드·기본값·장소·상황 발생·규칙·비공개 정보 계약이 포함되어 있습니다. 모호한 원본·모델·지도·행동 결과는 질문하게 하며, 지원하지 않는 필드를 지어내거나 실행 결과를 미리 생성하지 않게 합니다. AI 출력은 아래 검증 단계를 통과한 뒤 실행하세요.

## 웹에서 범위별 JSON 편집

**새 실험 → JSON 편집**에서 전체 설정을 계속 편집할 수 있습니다. 같은 화면의 범위 선택으로 일부만 편집하거나, 시나리오·캐릭터·실험 조건 탭의 JSON 편집 버튼으로 해당 범위를 바로 열 수 있습니다.

| 편집 범위 | 입력할 JSON | 바뀌는 부분 |
|---|---|---|
| 전체 설정 | `ExperimentSpec` 객체 전체 | 실험 전체. 기존 파일 가져오기와 편집 유지 |
| 세계관 | `scenario`에서 `characters`를 제외한 객체 | `id`, `name`, `world`, `situation`, `defaults`, 선택적인 `environment`, `worldEngineInstructions`, `spatial` |
| 선택 캐릭터 | NPC 한 명의 객체 | 선택한 캐릭터 한 명. JSON 화면의 선택 목록으로 대상 변경 가능 |
| 전체 캐릭터 | NPC 객체들의 배열 | 캐릭터 목록 전체와 순서 |
| 실험 조건 | 실험 조건을 담은 객체 | `variants`, `repetitions`, `maxUtterances`, `concurrentRuns`, `maxConcurrentCalls`, `timeoutMs`, `evaluation`, `director`, 선택적인 `worldEngine`, `eventGenerator`, `scheduledEvents` |

세계관 JSON의 `name`은 시나리오 이름이며 최상위 실험 `name`과 다릅니다. 세계관의 기본 모델도 이 범위에 속합니다. 캐릭터나 비교 조건의 모델 재정의는 각 편집 범위에서 수정합니다. 부분 파일에는 `scenario` 같은 상위 포장 키를 덧붙이지 않고 선택한 범위의 내용 자체를 넣습니다. 전체 캐릭터만 최상위가 배열이고 나머지는 객체입니다.

**부분 편집은 해당 범위 전체를 교체**합니다. 표시된 현재 JSON을 수정하는 방식으로 사용하세요. 예를 들어 세계관 JSON에서 `environment`를 생략하면 기존 환경 규칙이 제거됩니다. 생략 가능한 기본값 필드를 지우면 스키마의 기본값이 적용될 수 있습니다. 다른 범위의 세계관·캐릭터·조건은 보존합니다.

적용할 때는 JSON 문법과 해당 범위의 구조를 확인하고, 전체 실험으로 조립해 다시 검증합니다. 캐릭터 ID 중복, 존재하지 않는 환경 수행자, 묶음 수 초과 같은 오류는 적용하지 않고 기존 설정을 유지합니다. NPC ID와 환경의 `actorIds`를 함께 바꾸는 작업은 전체 JSON에서 한 번에 수정하세요. 모델 계정 지원 여부는 적용 후 **설정 검증**으로 확인합니다.

범위·캐릭터·탭을 오가거나 편집 창을 닫았다 다시 열어도 미적용 JSON 초안을 보존합니다. 시나리오 탭의 환경 규칙 JSON에도 같은 보호를 적용합니다. 초안이 남아 있으면 저장·검증·실험 생성 버튼은 비활성화됩니다. 각 초안을 적용하거나 **현재 설정 다시 불러오기**, **모든 JSON 초안 되돌리기**로 되돌리세요. 환경 초안은 **현재 환경 설정 다시 불러오기**로 되돌릴 수 있습니다. 폼에서 같은 범위를 수정해 초안의 원본이 달라졌다면 자동 덮어쓰기를 막습니다. 필요한 초안 내용을 복사한 뒤 현재 설정을 다시 불러와 수정할 수 있습니다. 초안은 현재 화면의 메모리에만 보관되므로 브라우저를 새로고침하거나 종료하면 사라집니다.

[복사용 변환 프롬프트](prompts/requirements-to-experiment-json.txt)는 전체 실험 JSON을 생성합니다. AI에게 부분 JSON만 요청하려면 완성된 전체 설정을 함께 주고 위 표에 맞춰 해당 범위를 추출하도록 요청하세요. 예를 들어 ‘캐릭터는 바꾸지 말고 `scenario`에서 `characters`를 제외한 객체만 출력’이라고 지정하면 세계관 편집에 사용할 수 있습니다.

## 검증과 실행

실행에서 다운로드한 config.json은 스냅샷 래퍼이므로 내부 `spec`을 꺼내 사용합니다. 생성된 결과를 UTF-8 **BOM 없이** `examples/my-experiment.json`으로 저장합니다. JSON은 큰따옴표를 사용하고 주석·후행 쉼표·Markdown 코드 펜스를 허용하지 않습니다. 빈 문자열, 키 생략, `null`은 서로 다르며 선택 설정은 보통 키를 생략해 표현합니다.

### 모델 호출 없이 문법과 구조 확인

의존성 설치 후 프로젝트 루트에서 다음 명령으로 JSON과 스키마를 확인할 수 있습니다. 이 명령은 서버에 연결하지 않습니다.

```powershell
node --import tsx --input-type=module -e 'import {readFileSync} from "node:fs"; import {experimentSchema} from "./src/shared/schema.ts"; const spec=experimentSchema.parse(JSON.parse(readFileSync("examples/my-experiment.json","utf8"))); console.log(JSON.stringify({valid:true,npcs:spec.scenario.characters.length,conditions:spec.variants.length,runs:spec.variants.length*spec.repetitions},null,2));'
```

스키마는 알려지지 않은 키를 제거할 수 있습니다. 따라서 구조 검증 통과만으로 모든 요구가 적용되었다고 판단하지 마세요. `npcCount: 6`, `delivery: "batched"` 같은 잘못된 키가 무시되고 실제 필드의 기본값이 적용될 수 있습니다. AI가 출력한 키를 필드 표와 비교하고, 서버 검증 응답의 정규화된 `spec`도 확인하세요.

### 실행 서버의 모델까지 확인

실행하려는 서버를 먼저 시작합니다. 기본 Codex 서버는 4317, API 서버는 4318입니다. 다음은 API 서버를 대상으로 한 명령입니다.

```powershell
npm run cli -- --url http://127.0.0.1:4318 models
npm run cli -- --url http://127.0.0.1:4318 validate --config examples/my-experiment.json

# 설정을 검토할 수 있게 일시정지 상태로 묶음만 생성
npm run cli -- --url http://127.0.0.1:4318 run --config examples/my-experiment.json --paused

# 반환된 묶음 ID를 사용해 한 차례만 실행하거나 계속 실행
npm run cli -- --url http://127.0.0.1:4318 step <묶음-ID>
npm run cli -- --url http://127.0.0.1:4318 resume <묶음-ID>
```

`models`, `validate`, 일시정지 상태의 생성은 발화·평가 추론을 실행하지 않습니다. `step`, `resume`, 일반 `run`부터 실제 모델 호출이 발생할 수 있습니다. `step` 한 번은 해당 전달 방식의 수신 처리까지 포함하고, 평가 경계에 도달하면 평가도 수행할 수 있습니다. 모델 목록 검증이 실제 호출 권한·문맥 길이·실행 성공까지 보장하지는 않습니다.

웹에서는 **새 실험 → JSON 편집**에서 파일을 가져오거나 붙여 넣고 **JSON을 설정에 적용 → 설정 검증**을 사용합니다. 캐릭터별 최종 모델·추론, 전체 묶음 수, 발화 한도, 조기 종료, 예약 사건을 확인한 뒤 대기 상태로 생성하거나 시작합니다. 실행 시 설정이 스냅샷으로 고정되므로 편집한 JSON이 이미 생성한 묶음을 바꾸지는 않습니다.

### 자주 생기는 문제

| 현상 | 확인할 부분 |
|---|---|
| 모델·추론 조합 오류 | 실행 서버의 `models`, 캐릭터별 재정의, 모델만 바꾸고 남아 있는 기본 강도 |
| 120발화 이전에 완료 | `environment.stopOnGoals`, 모든 목표가 처음부터 참인지 |
| 120차례인데 대사가 더 적음 | 행동만 있는 차례도 공개 발화 수에 포함됨 |
| 목표 달성이 판단 불가 | 캐릭터 동기만 작성했는지, 환경 규칙이 없는지·꺼졌는지 |
| 계속 확인·준비만 반복 | 행동 수행자와 선행 조건이 맞는지, 결과와 다음 단계가 정해졌는지, 원본이 논의만 허용하는지 |
| 상태 조건·효과 검증 오류 | 키를 `initialState`에 선언했는지, 불리언과 문자열을 혼용했는지 |
| API가 아닌 CLI에서 실행 | JSON 대신 서버 주소와 `--adapter` 확인 |
| 다른 사람의 비밀을 처음부터 앎 | 비밀을 공개 `world`·환경 규칙에 넣었는지 |
| 의미 반복률과 어휘 반복률이 다름 | AI 지적과 문자열 유사도 지표는 별도이며 분모도 다름 |
| 바꾼 필드가 적용되지 않음 | 지원하지 않는 키, 상위 우선순위의 NPC 재정의, 이미 생성된 스냅샷을 확인 |

기준이 바뀌면 [schema.ts](../src/shared/schema.ts), [프롬프트 구성](../src/core/prompts.ts), [환경 판정](../src/core/progression.ts)이 실제 동작의 기준입니다. 변환 프롬프트도 그 규격과 함께 갱신하세요.


### 분산 공간과 장면 시계

`scenario.spatial.locations`의 `initialSituation`은 그 장소에서 시작하는 사람에게 전달된다. 각 NPC의 시작 위치는 `initialPositions`에 한 번씩 적는다. 통로의 `sightAndSound: true`는 열려 있는 동안 양 끝에서 일반 발언과 겉동작을 보고 듣게 한다. 귓속말은 같은 위치에서만 들리고 무전은 채널 구성원에게만 전달된다. `closesAtSeconds`에 도달하면 해당 통로를 통한 이동과 일반 대화가 끊긴다. 통과 중이던 사람은 마지막으로 확인된 출발 쪽에 남는다.

`scenario.clockEvents`는 AI 세계 시계에서 한 번 발생하는 관찰 목록이다. 각 항목에 고유 `id`, 시작 후 초 단위 `atSeconds`, 실제로 보거나 듣는 `text`를 적는다. 분산 공간에서는 `locationIds`로 전달 장소를 한정할 수 있다. 누군가 고치거나 취소하면 피할 수 있는 사고는 세계 판정과 진행 사건으로 처리한다. 두 기능은 세계관 JSON과 편집기의 시나리오 탭에 있다. [실제 장면별 설정](../assets/seowol/drama/README.md)

`scenario.spatial.travelLimits`에는 인물이 스스로 도달할 수 없는 목적지를 적는다. 항목은 `npcId`, `locationId`, 경계에 접근한 본인에게만 보이는 `reason`으로 구성한다. 다른 인물의 통행과 원격 통신은 가능하다. 외력이 사람을 옮기는 판정에는 해당 인물의 반응 기회와 실제 신체 변화가 필요하다. [무연역의 도겸](../assets/seowol/experiments/drama-last-platform.json)
