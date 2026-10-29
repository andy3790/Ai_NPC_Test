# NPC Dialogue Lab

Codex CLI를 NPC 실행기로 사용하는 로컬 대화 실험 환경입니다. 독립 NPC 세션의 캐릭터성·기억·말투·행동·세계관 이탈과 토큰·시간을 함께 기록합니다. 웹 화면과 CLI는 같은 SQLite 데이터와 실행 엔진을 사용합니다.

## 빠른 시작

필수 환경: **Node.js 24 이상**, 설치 및 로그인된 **Codex CLI**. 이 구현은 Windows의 Codex CLI **0.164.0**에서 검증했습니다. API 키를 앱에 별도로 입력하지 않고 기존 CLI 로그인을 사용합니다.

```powershell
node --version
codex --version
codex login status
npm ci
npm run build
npm start
```

브라우저에서 **http://127.0.0.1:4317** 을 엽니다. 이후에는 `npm start`로 실행합니다. 실제 모델 호출은 기존 Codex 계정의 사용량을 소비합니다.

Codex 로그인 없이 화면과 전달 방식을 먼저 확인하려면 설치·빌드 후 모의 서버를 실행합니다.

```powershell
npm run cli -- serve --mock --port 4318 --data data/mock
```

**http://127.0.0.1:4318** 에서 새 실험을 만들면 모의 모델로 동작합니다. 모의 출력은 연결과 계측 검증용이며 캐릭터 연기 품질을 뜻하지 않습니다.

1. **새 실험**에서 세계관과 시작 상황을 작성합니다.
2. **캐릭터** 탭에서 NPC를 추가하고 기억·말투·행동·금기와 선택적인 모델 재정의를 입력합니다.
3. **실험 조건**에서 모델·추론·기억·전달 방식의 비교 조합을 생성합니다. NPC별 최종 적용값을 펼쳐 확인할 수 있습니다.
4. **실험 시작** 또는 **대기 상태로 생성**을 선택합니다.
5. 묶음별 대화·호출·평가·수신 상태를 확인합니다. 일시정지 후 한 발화 진행과 상황 투입이 가능합니다.
6. **비교 분석**에서 최대 4개 묶음을 나란히 보고, **데이터 내보내기**에서 ZIP을 받습니다.

기본값은 NPC 3명, 묶음당 공개 발화 **최대 60개**, 동시 묶음 2개, 동시 모델 호출 2개, 10발화마다 및 종료 시 평가입니다. 기본 시나리오는 모든 구조화 목표 달성 시 조기 종료합니다. 장기 대화 시험은 시나리오의 **모든 목표 달성 시 종료**를 끄면 됩니다. 모델과 추론 선택지는 현재 CLI에서 조회합니다. `ultra`는 자동 위임을 활성화하므로 독립 NPC 세션을 유지하는 이 실험에서는 제외합니다.

## 행동·환경 결과와 진행 목표

v1.1은 불변 세계 설정과 실행 중인 장면 상태를 구분합니다. 이전 프롬프트는 설정 외 사건 확정을 금지하면서 관찰 결과를 공급하지 않아, 점검·점화 시도가 계속 미확인으로 남았습니다. 이제 **시나리오 작성자가 정의한 규칙**에 따라 엔진이 결과를 확정합니다. AI 진행자가 새 사실을 만드는 방식이 아닙니다.

`scenario.environment`의 `initialState`, `actions`, `goals`를 JSON으로 편집합니다. 각 행동은 수행 가능한 NPC(`actorIds`), 선행 조건(`conditions`), 기존 상태 키의 새 값(`effects`), 공개 결과문(`result`)을 갖습니다. 조건 연산은 `eq`, `neq`, `gte`, `lte`입니다. 기본 `once:true`는 한 번만 성공합니다. 새로운 상태 키나 자료형 변경은 검증에서 거부합니다. 세계와 충돌하지 않는 규칙을 작성할 책임은 시나리오 작성자에게 있습니다.

NPC는 대사·행동에 더해 `actionId` 하나 또는 `null`을 반환합니다. 엔진은 권한·선행 조건을 확인한 뒤 발화와 결과를 하나의 SQLite 트랜잭션에 저장합니다. 불가능한 행동은 실패 호출로 남고 공개 발화나 상태에 반영하지 않습니다. 재개 시 이미 성공한 결과가 중복 적용되지 않습니다. 결과는 `환경 결과` 공개 사건으로 모든 NPC에게 전달됩니다. 매 발화 모드에서는 사건 하나당 NPC 수만큼 추가 수신 호출이 생기며 원본 사건 ID에 사용량이 연결됩니다.

기본 안개항 규칙은 기름 확인 → 방침 제안 → 각자의 동의 → 기름 공급 → 윤의 점화 → 미루의 기록입니다. 다른 NPC의 동의를 대신할 수 없습니다. 점등 성공은 밤샘 지속·미래 날씨·추가 자원 확보를 뜻하지 않습니다. 성공 조건과 결과는 실행 전 스냅샷에 포함됩니다. 매 공개 발화 요청에 최신 공개 상태와 허용 행동을 제공하며, 이것은 캐릭터 원본 설정 재주입과 별개입니다. 수신 호출에는 추가 상태·설정을 재주입하지 않습니다.

`enabled:false` 또는 환경 설정 생략은 기존 동작을 유지합니다. `stopOnGoals:false`는 달성 후에도 발화 한도까지 계속합니다. 수동 상황 투입과 NPC의 자유 서술은 구조화 목표를 자동 달성시키지 않습니다. 환경 상태는 공개 결과 기록에서 복원하며, 이전 실험의 설정·평가를 새 규칙으로 소급 변경하지 않습니다.

웹 시나리오 탭에서 환경 규칙 사용·목표 달성 시 종료를 선택하고 규칙 JSON을 편집할 수 있습니다. 이전에 저장된 안개항 설정에는 **안개항 환경 규칙 추가** 버튼으로 적용하세요. 다른 시나리오에는 해당 세계에 맞는 규칙을 직접 작성하세요.

## 두 가지 대화 전달 방식

| 설정 | 동작 |
|---|---|
| `batched_on_turn` | 발화를 모든 다른 NPC의 수신함에 저장합니다. 자기 차례에 새 내용을 모아서 입력받고 한 번 발화합니다. |
| `per_utterance` | 매 발화마다 다른 NPC 모두에게 모델 요청을 보냅니다. 각각 `{"received":true}`로 수신 처리한 뒤 다음 공개 화자로 넘어갑니다. |

공개 발언은 두 모드 모두 순차적입니다. 수신 처리는 서로 다른 세션끼리 병렬 실행하되 전체 호출 한도를 따릅니다. 동일 세션에는 동시에 두 요청을 보내지 않습니다. 자신의 발화를 자신에게 재입력하지 않으며, 이미 받은 내용은 다시 묶어서 전달하지 않습니다.

NPC 3명·공개 발화 6개라면 모아 전달 모드의 NPC 호출은 6회, 매 발화 전달 모드는 공개 발화 6회 + 수신 12회입니다. 평가·진행자·상황 투입은 별도 호출입니다. 모아 전달 모드는 종료 시 다음 차례를 받지 못한 NPC의 수신함에 대기가 남을 수 있습니다. 매 발화 전달 모드는 마지막 발화의 수신까지 마칩니다.

기억 방식은 `initial_only`(초기 설정 후 세션 유지), `reinject_on_speech`(본인의 공개 발화 요청마다 원본 설정 재주입)를 지원합니다. 수신 확인에는 설정을 재주입하지 않습니다. 설정과 세계관의 최초 정보는 세션 지시문에 들어가며 Codex의 기본 문맥 압축 동작을 사용합니다. 따라서 이 비교는 초기 지시문 자체를 삭제하는 실험이 아니라 **추가 상기 입력의 효과**를 비교합니다.

진행자는 `round_robin` 또는 `director`입니다. AI 진행자는 다음 화자만 선택하고 연속 발화와 장기 배제를 제한합니다. 모델·추론 우선순위는 **NPC 재정의 → 조건 → 시나리오 기본값**입니다.

## CLI 사용

웹 화면을 열지 않고도 같은 서버를 사용할 수 있습니다. 서버를 먼저 시작하고 다른 터미널에서 명령을 실행합니다.

```powershell
# 서버 실행
npm run cli -- serve --port 4317 --data data

# 현재 이용 가능한 모델 조회 및 계정에 맞춘 예제 생성
npm run cli -- models
npm run cli -- example --out examples/my-experiment.json
npm run cli -- validate --config examples/my-experiment.json

# 실험 생성: 결과에 experimentId와 묶음별 id가 나옵니다.
npm run cli -- run --config examples/my-experiment.json
npm run cli -- run --config examples/my-experiment.json --paused
npm run cli -- status
npm run cli -- status <묶음-ID>

npm run cli -- pause <묶음-ID>
npm run cli -- step <묶음-ID>
npm run cli -- resume <묶음-ID>
npm run cli -- inject <묶음-ID> --text "등대 입구의 안개가 옅어졌다."
npm run cli -- evaluate <묶음-ID>
npm run cli -- stop <묶음-ID>

npm run cli -- analysis --runs <묶음-ID-1>,<묶음-ID-2>
npm run cli -- export <묶음-ID> --out exports/my-run
```

다른 포트의 서버는 `npm run cli -- --url http://127.0.0.1:4318 status`처럼 지정합니다. `step`, `inject`, 수동 `evaluate`는 진행 중인 요청이 끝난 후 사용하세요. 중단·완료된 묶음은 변경하지 않고 같은 설정으로 새 실험을 생성합니다. 설정 JSON을 Git 등에 보관하면 동일 조건의 반복 실험을 만들 수 있습니다.

예제 파일:

- `examples/delivery-comparison.json`: 전달 방식 2개 비교, NPC 3명·최대 60발화, 환경 목표 달성 시 종료.
- `examples/memory-delivery-matrix.json`: 기억 2개 × 전달 2개, 총 4조건, 환경 규칙 포함.
- `examples/quick-check.json`: 환경 규칙 없는 원래 전달 계약 검사, 각 6발화·종료 평가.
- [세계관·캐릭터 팩](assets/npc-canon/README.md): 6개 세계관·36명 캐릭터, 18종 실행 설정, 이미지와 오프라인 카탈로그. 기본 예제와 별도로 사용할 수 있습니다.

예제의 모델을 사용할 수 없으면 `models`로 확인한 값으로 수정하거나 `example` 명령으로 다시 생성합니다. 지원하지 않는 조합은 다른 모델로 조용히 대체하지 않고 검증 단계에서 오류를 표시합니다.

## 평가와 데이터 해석

평가자는 원본 설정, 캐릭터 정보와 공개 대화·환경 결과를 받고 성격·말투·행동·기억·지식 범위·세계관 모순·사실 추가와 **의미 반복(repetition)·진행 정체(goal_stagnation)**를 검사합니다. 인용 근거가 실제 대상 발화의 부분 문자열인지 앱에서 검증합니다. AI의 지적은 사람이 **확정/기각/미검토**로 검토하고 메모를 남길 수 있습니다. 원래 AI 판단은 보존됩니다.

**어휘 반복률**은 최근 12개 공개 발화 안에서 같은 화자의 대사를 비교합니다. NFKC·소문자·문장부호 제거 후 문자 3-gram Dice 유사도 0.72 이상이면 반복으로 셉니다. 비교 가능한 발화 수가 분모이며, 20자 미만·행동 습관·환경 사건은 제외합니다. 분모가 없으면 0%가 아닌 `null`입니다. 범위·임계값·최소 문자는 평가 설정에서 변경합니다. 표현이 다른 같은 의미는 놓칠 수 있어 AI의 의미 반복 지적률을 별도로 제공합니다. 목표 달성은 AI의 성공 주장 대신 선언된 상태 조건으로 판정하며, 목표별 최초 달성 순번과 마지막 상태 변화 이후 발화 수도 기록합니다. 목표 미정의는 미달성과 구분합니다. 모든 수치와 AI 지적은 NPC에게 피드백하지 않습니다.

평가가 실패하면 실패 구간으로 남고 대화는 계속됩니다. 판단 불가와 평가 실패는 정상 판정이 아닙니다. 평가 맥락이 설정된 문자 한도를 넘으면 앞부분을 제외하고 `contextTruncated`로 표시합니다. 원본 대화는 삭제하지 않습니다. 평가 결과는 NPC에게 전달하지 않습니다.

계측은 공개 발화·수신·진행자·평가 호출을 구분합니다. 실패와 재시도의 사용량도 합계에 포함합니다. 토큰은 CLI 보고값을 사용하며 캐시 입력·추론 출력은 전체 토큰에 다시 더하지 않습니다. 누락값은 `null`/빈 CSV 셀로 저장합니다. **첫 출력 시간은 클라이언트가 첫 텍스트 이벤트를 받은 시간이며, 순수 추론 시간이 아닙니다.**

내보내기 ZIP에는 아래 파일이 들어갑니다.

| 파일 | 내용 |
|---|---|
| `records.jsonl` | 설정·발화·수신·호출·평가와 원본 이벤트 |
| `utterances.csv` | 공개 발화, 생성·수신 토큰, 전달 완료 시간 |
| `invocations.csv` | 모든 호출 시도, 토큰, 시간, 실제 입력·출력, 오류 |
| `receipts.csv` | 원본 발화와 수신 NPC, 처리 호출의 연결 |
| `summary.csv` | 묶음별 사용량·시간·평가 요약 |
| `model-metrics.csv` | 모델·추론·전달·기억·호출 종류별 집계 |
| `evaluations.csv`, `findings.csv` | 평가 범위·실패·지적·사람의 검토 |
| `quality.json`, `repetition.csv`, `goals.csv` | 반복률·비교 근거 쌍, 공개 상태, 목표별 현재 달성·최초 달성 순번 |
| `config.json` | 실행 당시 설정·버전·해시·적용된 세션 설정 |
| `transcript.md` | 읽기용 공개 대화록 |
| `data-dictionary.md` | 필드 정의, 단위, 결측값과 집계 기준 |

각 파일의 `runId`, `id`, `utteranceId`, `invocationId`로 결합합니다. 모아 전달의 수신 비용은 발화 호출과 분리하여 측정할 수 없으므로 `receipts.csv`에서 수신을 처리한 발화 호출로 연결합니다. 개별 발화의 `receiveTokens`는 독립 수신 호출의 합계입니다.

Python 표준 라이브러리만으로 여러 내보내기 폴더를 집계할 수 있습니다.

```powershell
python scripts/analyze.py exports/my-run exports/other-run --out exports/comparison.csv
```

## 저장·복구와 운영

- 기본 저장소는 `data/npc-lab.sqlite`입니다. 실행 입력·출력·캐릭터 비공개 설정도 포함되며 Git에서 제외됩니다. Codex 세션은 기존 Codex 사용자 저장소에도 남습니다.
- 브라우저를 닫아도 서버가 실행 중이면 대화가 계속됩니다. 서버 종료는 터미널의 `Ctrl+C`로 처리합니다.
- 일시정지는 현재 공개 발화와 필요한 수신 처리를 마친 경계에서 적용됩니다. `stop`은 활성 호출에 중단을 요청합니다.
- 서버 재시작 후 실행 중이던 묶음은 일시정지됩니다. **재개** 시 미확정 turn을 조회하여 완료된 출력만 반영합니다. 확인할 수 없는 호출은 재전송하지 않고 오류로 남깁니다. 새 실험을 만들면 독립된 세션으로 시작합니다.
- Codex는 첫 요청 전의 빈 세션을 영구 저장하지 않을 수 있습니다. 한 번도 전송하지 않았다는 기록이 있는 빈 세션만 동일 설정으로 재생성하고 `session/recreated_empty` 이벤트에 이전·새 thread ID를 남깁니다. 이미 요청한 세션은 누락되어도 자동 교체하지 않습니다.
- 재접속 후 누적 사용량 기준값을 확인할 수 없는 호출은 `unknown_baseline`입니다. 비정상 종료로 실행 시간 일부가 소실되면 `timingComplete=false`를 표시합니다. 알려진 값만 합산하므로 `missingUsage`를 함께 확인하세요.
- 로컬 서버는 `127.0.0.1`에만 바인딩하고 다른 웹 출처의 요청을 거부합니다. NPC용 세션에서는 코드 실행·웹·연결 도구를 비활성화하고 텍스트 역할 지시문을 사용합니다. 인증 파일을 복사하거나 로그에 출력하지 않습니다.
- 여러 실험이 동시에 실행되면 활성 실험 중 가장 작은 `maxConcurrentCalls`를 공통 한도로 사용합니다. 계정 사용량 한도나 인증 문제는 호출 오류로 기록됩니다.

환경 변수: `PORT`(기본 4317), `NPC_LAB_DATA`(기본 data), `CODEX_BIN`(Codex 실행 파일의 절대 경로), `NPC_LAB_ADAPTER=mock`(모의 엔진). `CODEX_BIN`은 네이티브 실행 파일이나 `codex.js`를 지원하며 `.cmd`/`.ps1` 래퍼는 사용하지 않습니다.

## 개발·검증

```powershell
npm run typecheck
npm test
npm run build

# 위 검사 + 세계관 팩 검증 + Git 업로드 후보 검사 (실제 모델 호출 없음)
npm run verify

# 실제 모델을 호출하지 않는 화면 검증
npm run smoke:ui
npm run assets:gallery

# 두 NPC × 6발화 × 두 전달 방식 + 종료 평가. 기존 Codex 계정 사용량을 사용합니다.
npm run smoke:live

# 3 NPC, 두 전달 방식, 사전 환경 규칙과 목표 달성의 실제 Codex 검증
node --import tsx scripts/progression-live.ts

# 모의 서버는 실제 실험과 저장 폴더를 분리합니다.
npm run cli -- serve --mock --port 4318 --data data/mock
```

`smoke:live`는 `.cache/live-smoke-<시간>/`에 SQLite, ZIP, 결과 요약을 저장합니다. `smoke:ui`는 모의 서버를 시작하고 구성·실행·수신 계측·비교·ZIP·모바일 화면을 검증한 뒤 종료합니다. 스크린샷은 `.cache/screenshots/`에 남습니다.

브라우저 검사는 Windows에서 설치된 Edge를 사용하고, 다른 OS에서는 `npx playwright install chromium`으로 설치한 Chromium을 사용합니다. `NPC_BROWSER_CHANNEL` 또는 `NPC_BROWSER_EXECUTABLE` 환경 변수로 브라우저를 지정할 수 있습니다. GitHub Actions는 Node.js 24의 Windows·Linux 검증과 Linux 브라우저 검증을 실행하며 Codex 인증이나 실제 모델을 사용하지 않습니다.

구조: `src/core` 실행·저장·계측·내보내기, `src/adapters` Codex/모의 연결, `src/shared` 설정 스키마·타입, `src/server` HTTP·SSE, `src/web` React, `src/cli.ts` CLI. 로컬 API는 [docs/api.md](docs/api.md)에 정리되어 있습니다.

## 저장소와 공개 파일

실행 DB·원본 호출 로그·내보내기·빌드·임시 파일은 Git에서 제외합니다. `npm run check:publish`는 저장소 초기화 전에도 포함될 파일을 검사하고 `.cache/publication-manifest.json`에 파일별 크기·SHA256과 결과를 저장합니다. 업로드 절차와 파일 범위는 [GitHub 업로드 안내](docs/publishing.md), 데이터 취급 범위는 [SECURITY.md](SECURITY.md)를 참고하세요.

라이선스는 현재 미지정입니다. 공개 라이선스로 배포할 경우 코드·시나리오·이미지의 사용 조건을 선택해 `LICENSE`에 명시하세요.
