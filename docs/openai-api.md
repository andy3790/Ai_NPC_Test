# OpenAI API 실행

v1.2부터 Codex CLI와 OpenAI Responses API를 선택할 수 있습니다. 서버 시작 시 실행 경로를 고정하며 같은 대화 엔진·웹 화면·CLI·내보내기를 사용합니다. Codex 기본 실행은 `npm start`, API 실행은 `npm run start:openai`입니다. 각 서버의 포트와 저장 폴더가 다르면 동시에 실행할 수 있습니다.

## 키 설정과 시작

Node.js 24 이상이 필요합니다. API 경로는 Codex CLI 설치나 로그인이 필요하지 않습니다.

```powershell
npm ci
npm run build
if (!(Test-Path .env)) { Copy-Item .env.example .env }
notepad .env
```

`.env`의 `OPENAI_API_KEY=` 뒤에 본인의 키를 입력해 저장합니다. 키를 채팅이나 실험 JSON에 붙여 넣지 마세요. `.env`는 Git에서 제외됩니다.

```powershell
npm run start:openai
```

**http://127.0.0.1:4318** 을 엽니다. 화면에 `OpenAI API 연결`이 표시됩니다. 기본 DB는 `data/openai/npc-lab.sqlite`, API 세션·복구 기록은 그 아래 `runtime/openai/`에 저장합니다. 기존 Codex 서버는 **http://127.0.0.1:4317**, 기본 저장 폴더 `data/`를 계속 사용합니다.

이미 환경 변수에 키를 설정했다면 개발 서버도 직접 시작할 수 있습니다.

```powershell
npm run cli -- serve --adapter openai --port 4318
npm run cli -- --url http://127.0.0.1:4318 models
npm run cli -- --url http://127.0.0.1:4318 example --out .cache/my-api-experiment.json
npm run cli -- --url http://127.0.0.1:4318 validate --config .cache/my-api-experiment.json
npm run cli -- --url http://127.0.0.1:4318 run --config .cache/my-api-experiment.json --paused
```

`.env` 파일 자동 읽기는 `start:openai`, `smoke:openai` 명령에 적용됩니다. `npm run cli -- serve`는 현재 프로세스 환경 변수를 사용합니다. `--data`로 저장 폴더를 바꿀 수 있으며, `NPC_LAB_DATA`가 설정되어 있으면 기본 폴더보다 우선합니다. 기존 실험을 다른 어댑터로 재개하는 것은 거부합니다.

API 서버의 새 예제는 묶음당 **최대 6발화**, 평가 간격 6발화, 동시 묶음·호출 각각 1개로 시작합니다. 기존 Codex 예제 기본값은 유지합니다. 가져온 설정은 원본 발화 수를 유지하므로 실행 전에 한도를 확인하세요. 두 전달 방식과 두 기억 방식, NPC별 모델·추론 지정, 진행자·평가를 동일하게 사용할 수 있습니다.

## 모델과 출력 한도

`GET /v1/models`에서 계정에 표시되는 모델 중 앱의 지원표에 있는 모델을 제공합니다. 기본 지원표는 GPT-6 Luna, GPT-6.1 Terra, GPT-6.1 Sol, GPT-6 Astra, GPT-6 Sol, GPT-4.1 mini입니다. 새 예제는 사용 가능한 목록의 첫 모델과 `low` 또는 해당 모델의 기본 강도를 사용합니다. 선택한 모델을 다른 모델로 자동 대체하지 않습니다.

API 모델 목록에는 추론 강도가 포함되지 않으므로 지원 강도는 공식 문서에 따른 앱의 지원표에서 제공합니다. 계정·프로젝트의 실제 호출 권한과 크레딧 적용 여부는 API 응답과 계정 콘솔에서 확인해야 합니다. 모델 목록에 보인다는 사실만으로 실행 성공이 보장되지는 않습니다.

추가 모델이나 고정 스냅샷은 `.env`의 `NPC_OPENAI_MODELS`로 등록할 수 있습니다. 본인이 확인한 Responses API·구조화 출력 지원 모델을 지정합니다.

```dotenv
NPC_OPENAI_MODELS=[{"id":"your-model-id","efforts":["low","medium"],"defaultEffort":"low","reasoning":true}]
OPENAI_MAX_OUTPUT_TOKENS=4096
```

추론 기능이 없는 모델은 `efforts:["none"]`, `defaultEffort:"none"`, `reasoning:false`로 등록합니다. 기존 ID를 등록하면 그 모델의 지원표를 덮어씁니다. `OPENAI_MAX_OUTPUT_TOKENS`는 **호출당 추론·출력 토큰의 합계 상한**이며 금액이나 실험 전체 토큰 한도가 아닙니다. 세션 생성 시 고정하고 실제 요청 이벤트에도 기록합니다. 이 한도에 도달해 출력이 불완전하면 정상 발화로 배포하지 않고 일시정지합니다. 지원표와 출력 한도 변경은 서버를 다시 시작한 뒤 새 실험에 적용하세요.

## 세션·계측·복구

- NPC마다 별도 로컬 세션과 `previous_response_id` 연결을 유지합니다. 다른 묶음의 응답 ID를 사용하지 않습니다. 수신 확인도 같은 NPC 응답 연결에 포함하며 공개 대화에는 넣지 않습니다.
- `instructions`는 API의 응답 연결에서 자동 상속되지 않으므로 동일한 역할·캐릭터 지시문을 각 요청에 설정합니다. `reinject_on_speech`는 기존과 같이 공개 발화 요청의 `input.originalCharacterAndWorld`에 추가 상기 입력을 넣으며, 수신 확인에는 추가 상기를 넣지 않습니다.
- API의 `usage`를 호출 단위로 직접 기록하고 `usageStatus=reported_response`로 구분합니다. 누적 카운터로 환산하지 않습니다. 캐시 입력·캐시 쓰기·추론 출력은 제공된 경우만 기록하고 전체 토큰에 다시 더하지 않습니다. 누락 항목은 `null`입니다.
- 실제 응답 모델, response ID, 요청 ID, 요청 본문, 구조화 출력, 원본 스트리밍·사용량 이벤트를 기록합니다. 첫 출력 시간은 첫 `response.output_text.delta`의 관측 시점입니다. 기존 CSV·JSONL·ZIP과 분석 화면을 그대로 사용합니다.
- HTTP 오류·출력 불완전·형식 오류는 정상 발화로 배포하지 않습니다. 자동 재시도는 하지 않습니다. 네트워크 단절·시간 초과 후 결과가 불명확하면 먼저 저장된 response ID를 조회합니다. 완료된 결과만 복구하며 ID나 완료 여부를 확인할 수 없으면 재개를 거부합니다.
- API 호출은 `store:true`를 사용하므로 입력·응답이 OpenAI 서비스에도 저장됩니다. API 키는 서버 메모리와 본인이 만든 `.env`에서만 관리하며 요청 본문·DB·내보내기에는 포함하지 않습니다. 서비스의 응답 보존 기간이 지나거나 이전 응답이 삭제되면 같은 연결의 재개가 실패할 수 있습니다.
- API 경로는 자동 문맥 압축을 구현하지 않습니다. `truncation:disabled`로 기록을 조용히 잘라내는 것을 방지하며 문맥 한도 오류는 일시정지로 남깁니다. Codex CLI의 문맥 압축과 서로 다른 조건임을 고려해 비교하세요.

## 짧은 실제 연결 검사

키 설정 후 아래 명령은 기존 서버 없이 별도 엔진에서 **2명·2발화·두 전달 방식·종료 평가**를 실행합니다. 성공 경로는 공개 발화 4회, 수신 2회, 평가 2회로 **총 8회 API 호출**입니다. 실제 크레딧을 사용하며 `verify`나 CI에서는 실행하지 않습니다.

```powershell
npm run smoke:openai
```

선택 모델은 계정에서 조회된 첫 지원 모델입니다. `NPC_OPENAI_SMOKE_MODEL` 환경 변수로 지원표 안의 모델을 지정할 수 있습니다. 결과와 ZIP은 `.cache/openai-smoke-<시간>/`에 저장됩니다. 이 검사는 연결·전달·계측 검사이며 긴 대화의 캐릭터성 유지 성능을 의미하지 않습니다.

## 공식 규격

- [Responses API](https://developers.openai.com/api/reference/typescript/resources/responses/methods/create)
- [대화 상태와 이전 응답 연결](https://developers.openai.com/api/docs/guides/conversation-state)
- [구조화 출력](https://developers.openai.com/api/docs/guides/structured-outputs)
- [스트리밍 이벤트](https://developers.openai.com/api/reference/resources/responses/streaming-events)
- [GPT-6 Luna의 추론 강도와 지원 기능](https://developers.openai.com/api/docs/models/gpt-6-luna)
