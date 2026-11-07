# OpenAI API 실행

앱 1.4.0은 Codex CLI와 OpenAI Responses API를 선택할 수 있습니다. 서버 시작 시 실행 경로를 고정하며 같은 대화 엔진·웹 화면·CLI·내보내기를 사용합니다. Codex 기본 실행은 `npm start`, API 실행은 `npm run start:openai`입니다. 각 서버의 포트와 저장 폴더가 다르면 동시에 실행할 수 있습니다.

## 키 설정과 시작

Node.js 24 이상이 필요합니다. API 경로는 Codex CLI 설치나 로그인이 필요하지 않습니다.

```powershell
npm ci
npm run build
npm run start:openai
```

**http://127.0.0.1:4318** 을 엽니다. 키가 없어도 서버와 기존 기록은 열립니다. 화면 상단의 **API 키 설정**에서 개인 키를 입력하고 **키 확인 후 적용**을 누릅니다. 키가 없으면 입력란을 자동으로 펼칩니다. 서버는 모델 목록 조회로 키를 확인하며 이 단계에서 발화 생성은 하지 않습니다. 적용에 실패하면 기존 키 선택을 유지하고 오류를 표시합니다. 모델 목록 조회 성공이 모든 모델의 실행 권한·잔액을 보장하지는 않습니다.

기본 DB는 `data/openai/npc-lab.sqlite`, API 세션·복구 기록은 그 아래 `runtime/openai/`에 저장합니다. 기존 Codex 서버는 **http://127.0.0.1:4317**, 기본 저장 폴더 `data/`를 계속 사용합니다.

### 개인 키 우선순위와 보관 범위

| 상태 | 새 실험에서 사용하는 키 |
|---|---|
| 이 브라우저에서 개인 키를 적용함 | 해당 개인 키 |
| 개인 키 없음, 서버 환경 키 있음 | 서버 `OPENAI_API_KEY` (`.env` 포함) |
| 둘 다 없음 | 실행하지 않고 개인 키 입력 안내 |

- 개인 키는 **해당 브라우저에서 새로 만드는 실험**에만 연결합니다. 같은 브라우저 프로필·접속 호스트의 탭은 선택을 공유합니다. 다른 브라우저·시크릿 창은 별개입니다. `localhost`와 `127.0.0.1`도 서로 다른 브라우저 식별 범위입니다.
- 키 원문은 서버 메모리에만 보관합니다. 브라우저 새로고침·창 닫기는 키를 지우지 않으며, 서버 재시작 시 다시 입력합니다. `.env` 파일을 변경하지 않고 브라우저 저장소·DB·내보내기에 키 원문을 쓰지 않습니다. 브라우저에는 키가 아닌 식별 쿠키만 남습니다.
- **개인 키 해제**는 새 실험에서 서버 환경 키를 사용하도록 선택을 해제합니다. 서버 환경 키도 없으면 입력 안내로 바뀝니다.
- 기존 실험의 NPC·수신·진행자·평가·세계·상황 호출은 **생성 당시 키**로 계속 실행합니다. 키를 교체·해제해도 기존 실험의 키는 서버 종료까지 유지합니다. 실행 중 키를 바꿔 응답 연결이나 비용 귀속이 섞이지 않게 하기 위한 규칙입니다.
- 서버 재시작 후 개인 키 실험을 재개하려면 원래 키를 다시 입력합니다. 서버 환경 키나 다른 개인 키로 자동 대체하지 않습니다. 브라우저 식별 쿠키를 지웠거나 다른 브라우저로 옮겼어도 동일 키를 입력하면 재개할 수 있습니다.
- **실행 설정 → API 키 출처**에서 개인 키인지 서버 환경 키인지 확인합니다. 키 원문은 표시하지 않습니다. 예전 API 기록은 서버 환경 키로 취급합니다.
- 이 기능은 로그인·기록 접근 권한 분리가 아닙니다. 기록 조회는 기존과 같이 로컬 관리자 범위입니다. 상세 보관·제어 범위는 [보안 문서](../SECURITY.md)를 참고하세요.

### 서버 환경 키와 CLI

페이지 입력 대신 서버 키를 기본값으로 쓰려면 다음과 같이 `.env`를 만듭니다.

```powershell
if (!(Test-Path .env)) { Copy-Item .env.example .env }
notepad .env
```

`OPENAI_API_KEY=` 뒤에 본인의 키를 입력한 뒤 서버를 시작하거나 재시작합니다. 키를 채팅·실험 JSON·변환 프롬프트에 붙여 넣지 마세요. `.env`는 Git에서 제외됩니다.

이미 환경 변수에 키를 설정했다면 개발 서버도 직접 시작할 수 있습니다. CLI는 브라우저의 개인 키 선택을 공유하지 않으며 서버 환경 키로 모델 조회·검증·새 실험을 실행합니다. 개인 키로 만든 실험의 재개·한 차례·상황 투입·평가는 원래 브라우저 또는 동일 키를 입력한 브라우저에서 수행하세요.

```powershell
npm run cli -- serve --adapter openai --port 4318
npm run cli -- --url http://127.0.0.1:4318 models
npm run cli -- --url http://127.0.0.1:4318 example --out examples/local-api-experiment.json
npm run cli -- --url http://127.0.0.1:4318 validate --config examples/local-api-experiment.json
npm run cli -- --url http://127.0.0.1:4318 run --config examples/local-api-experiment.json --paused
```

`.env` 파일 자동 읽기는 `start:openai`, `smoke:openai` 명령에 적용됩니다. `npm run cli -- serve`는 현재 프로세스 환경 변수를 사용합니다. `--data`로 저장 폴더를 바꿀 수 있으며, `NPC_LAB_DATA`가 설정되어 있으면 기본 폴더보다 우선합니다. 기존 실험을 다른 어댑터로 재개하는 것은 거부합니다.

API 서버의 일반 예제는 최대 18차례·평가 간격 6·동시 묶음과 호출 각 1개로 시작합니다. 분산 공간 예제는 60차례·2조건입니다. 가져온 설정에는 파일에 지정된 한도가 적용됩니다. [운영 안내](running-experiments.md) · [세계 엔진](world-engine.md)

## 모델과 출력 한도

`GET /v1/models`에서 계정에 표시되고 로컬 카탈로그에서 API 사용이 켜진 모델을 선택할 수 있습니다. [모델 카탈로그](../src/config/models.json)

| 역할 | 새 API 실험의 기본 설정 |
|---|---|
| NPC 발언·행동·수신 | Terra low. 캐릭터나 비교 조건에 지정한 모델·강도는 각각 시나리오 기본값보다 우선합니다. |
| AI 세계 엔진 | Luna medium. 분산 공간의 시간 계획과 결과 판정도 이 설정을 공유합니다. |
| AI 진행자 | Luna low. Responses API로 다음 화자와 선정 이유를 반환합니다. 순번 진행에는 호출이 없습니다. |
| 선택형 평가자 | 일반 등대 예제는 Luna low, 분산 공간 예제는 NPC 기본 설정으로 시작합니다. 서월 사건극 6편은 꺼져 있습니다. |
| 선택형 상황 발생기 | 설정이 없는 상태에서 처음 켜면 당시 시나리오의 NPC 기본 설정을 복사합니다. 서월 사건극 6편은 꺼져 있습니다. |

새 API 예제에서 선호 모델을 사용할 수 없으면 계정의 기본 모델을 사용합니다. 해당 모델에서 원하는 강도를 지원하지 않으면 그 모델의 기본 강도를 사용합니다. 저장하거나 가져온 실험은 지정한 모델과 강도로 검증합니다. [역할별 기본값](../src/config/role-defaults.json)

OpenAI의 Decisions API는 같은 Luna로 후보별 확률과 선택 결과를 반환합니다. 출력 토큰 요금은 없고 자유 서술 선정 이유와 추론 강도 설정은 제공하지 않습니다. 「닫히는 문」 16차례에서 현행 진행자의 4회 호출은 사용량 기준 $0.000739였습니다. 입력·캐시 사용량이 같다고 가정하고 Decisions 요율을 적용하면 약 $0.000418입니다. [OpenAI Decisions 안내](https://developers.openai.com/api/docs/guides/decisions) · [호출별 사용량 집계](reviews/seowol-world-context-2026-11-07/usage.json)

API 모델 목록에는 추론 강도가 포함되지 않으므로 같은 JSON의 `api` 설정에서 제공합니다. 이 설정은 현재 구현의 지원 범위이며 계정의 모든 모델이나 최신 공식 지원 목록 자체가 아닙니다. 모델을 추가할 때 공식 규격을 따로 확인해야 합니다. 계정·프로젝트의 실제 호출 권한과 크레딧 적용 여부는 API 응답과 계정 콘솔에서 확인해야 합니다. 모델 목록에 보인다는 사실만으로 실행 성공이 보장되지는 않습니다.

모델 추가·비활성화·가격 수정은 [모델 설정 관리](model-catalog.md)에 따라 JSON 한 곳을 편집합니다. 모델 데이터 변경에는 재빌드·전체 회귀 테스트가 필요하지 않고 서버 시작 시 자동 형식 검사를 수행합니다. 기존 `.env`의 `NPC_OPENAI_MODELS`도 호환 목적으로 유지하며, 같은 ID의 API 능력 설정을 덮어씁니다. 본인이 확인한 Responses API·구조화 출력 지원 모델만 지정하세요.

```dotenv
NPC_OPENAI_MODELS=[{"id":"your-model-id","efforts":["low","medium"],"defaultEffort":"low","reasoning":true}]
OPENAI_MAX_OUTPUT_TOKENS=4096
```

추론 기능이 없는 모델은 `efforts:["none"]`, `defaultEffort:"none"`, `reasoning:false`로 등록합니다. 기존 ID를 등록하면 그 모델의 지원표를 덮어씁니다. 기본 출력 한도는 4096이며 앱에서 허용하는 값은 정수 256~128000입니다. 모델의 실제 지원 한도는 별도로 충족해야 합니다. `OPENAI_MAX_OUTPUT_TOKENS`는 **호출당 추론·출력 토큰의 합계 상한**이며 금액이나 실험 전체 토큰 한도가 아닙니다. 세션 생성 시 고정하고 실제 요청 이벤트에도 기록합니다. 이 한도에 도달해 출력이 불완전하면 정상 발화로 배포하지 않고 일시정지합니다. 지원표와 출력 한도 변경은 서버를 다시 시작한 뒤 새 실험에 적용하세요.

## 세션·계측·복구

- NPC마다 별도 로컬 세션과 `previous_response_id` 연결을 유지합니다. 다른 묶음의 응답 ID를 사용하지 않습니다. 수신 확인도 같은 NPC 응답 연결에 포함하며 공개 대화에는 넣지 않습니다.
- 새 API 실험의 AI 세계 판정은 실행 생성 시 `world-context/2`로 고정합니다. 시간 계획과 결과 판정마다 고정 장면과 차례별 상태를 두 개의 사용자 입력 블록으로 전달합니다. 지원 모델은 첫 블록 끝에 명시적 캐시 경계를 둡니다. 두 블록은 캐시가 비어 있어도 독립적으로 읽을 수 있습니다. 버전 필드가 없는 기존 실험은 저장된 응답 연결로 재개합니다. [실측 비교와 선택한 입력 범위](reviews/seowol-world-context-2026-11-07/report.md) · [OpenAI 프롬프트 캐시](https://developers.openai.com/api/docs/guides/prompt-caching)
- 세계 판정의 결과가 검증에서 거부되면 같은 상태와 거부 이유를 함께 전달합니다. 통신이 끊겨 결과가 불확실하면 로컬 호출 기록과 제공자가 저장한 응답을 대조해 완료 여부를 복구합니다. 실행 설정의 **세계 엔진 입력 버전** 및 내보낸 `config.json`의 `worldContextVersion`에서 실행 당시 방식을 확인할 수 있습니다.
- AI 진행자는 호출 시도마다 별도 세션을 생성하고 `previous_response_id: null`로 요청합니다. 최근 관찰과 화자별 대기 순서만 전달하며, 이전 진행자 요청·응답을 연결하지 않습니다. [입력 한도와 복구 정책](running-experiments.md#ai-진행자의-입력-범위)은 단일 공간과 분산 공간에 동일하게 적용합니다.
- 앱은 동일한 역할·캐릭터 `instructions`를 매 요청에 명시합니다. 이전 응답 연결의 지시문이 자동으로 이어진다고 가정하지 않습니다. `reinject_on_speech`는 기존과 같이 공개 발화 요청의 `input.originalCharacterAndWorld`에 추가 상기 입력을 넣으며, 수신 확인에는 추가 상기를 넣지 않습니다.
- API의 `usage`를 호출 단위로 직접 기록하고 `usageStatus=reported_response`로 구분합니다. 누적 카운터로 환산하지 않습니다. 캐시 입력·캐시 쓰기·추론 출력은 제공된 경우만 기록하고 전체 토큰에 다시 더하지 않습니다. 누락 항목은 `null`입니다.
- 실제 응답 모델, response ID, 요청 ID, 요청 본문, 구조화 출력, 원본 스트리밍·사용량 이벤트를 기록합니다. 첫 출력 시간은 첫 `response.output_text.delta`의 관측 시점입니다. 기존 CSV·JSONL·ZIP과 분석 화면을 그대로 사용합니다.
- HTTP 오류·출력 불완전·형식 오류는 정상 발화로 배포하지 않습니다. 자동 재시도는 하지 않습니다. 네트워크 단절·시간 초과 후 결과가 불명확하면 먼저 저장된 response ID를 조회합니다. 완료된 결과만 복구하며 ID나 완료 여부를 확인할 수 없으면 재개를 거부합니다.
- 도구 목록은 비워 보내고 구조화 JSON 출력 형식을 지정합니다. 셸·웹·외부 연결 도구를 NPC에게 제공하지 않습니다. API 원점은 `https://api.openai.com/v1`로 고정하며 임의 프록시 주소를 설정하는 기능은 없습니다.
- API 호출은 `store:true`를 사용하므로 입력·응답이 OpenAI 서비스에도 저장됩니다. API 키 원문은 모델 요청 본문·DB·내보내기에 포함하지 않습니다. 서비스의 응답 보존 기간이 지나거나 이전 응답이 삭제되면 같은 연결의 재개가 실패할 수 있습니다.
- API 경로는 자동 문맥 압축을 구현하지 않습니다. `truncation:disabled`로 기록을 조용히 잘라내는 것을 방지하며 문맥 한도 오류는 일시정지로 남깁니다. Codex CLI의 문맥 압축과 서로 다른 조건임을 고려해 비교하세요.

## 비용과 비교 조건

[환산 비용](data-and-evaluation.md#usd-환산-비용)은 관측 토큰과 코드의 단가 스냅샷으로 계산하며 실제 계정 잔액·크레딧 차감액을 조회하지 않습니다. CLI의 API 환산 비용과 함께 비교할 수 있지만 제공자별 문맥 관리·역할 지시문 운용은 다릅니다. 같은 시나리오·모델·추론·전달·환경·평가·출력 한도를 맞추고 미계측·실패 시도를 포함해 비교하세요.

## 짧은 실제 연결 검사

서버 환경 키 설정 후 아래 명령은 기존 서버 없이 별도 엔진에서 **2명·2발화·두 전달 방식·종료 평가**를 실행합니다. 페이지에서 입력한 키는 이 별도 프로세스에 전달하지 않습니다. 성공 경로는 공개 발화 4회, 수신 2회, 평가 2회로 **총 8회 API 호출**입니다. 실제 크레딧을 사용하며 `verify`나 CI에서는 실행하지 않습니다.

```powershell
npm run smoke:openai
```

선택 모델은 계정에서 조회된 첫 지원 모델입니다. `NPC_OPENAI_SMOKE_MODEL` 환경 변수로 지원표 안의 모델을 지정할 수 있습니다. 결과와 ZIP은 `.cache/openai-smoke-<시간>/`에 저장됩니다. 이 검사는 연결·전달·계측 검사이며 긴 대화의 캐릭터성 유지 성능을 의미하지 않습니다.

## 공식 규격

- [Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [대화 상태와 이전 응답 연결](https://developers.openai.com/api/docs/guides/conversation-state)
- [구조화 출력](https://developers.openai.com/api/docs/guides/structured-outputs)
- [스트리밍 이벤트](https://developers.openai.com/api/reference/resources/responses/streaming-events)
- [GPT-6 Luna의 추론 강도와 지원 기능](https://developers.openai.com/api/docs/models/gpt-6-luna)
