# 검증·분석 도구

모든 명령은 프로젝트 루트에서 실행합니다. 기본 검증은 `npm run verify`이며 실제 모델을 호출하지 않습니다. 빌드 후 `npm run verify:ui`로 대시보드·편집기·기록·평가 검토·캐릭터 카탈로그의 화면 검증을 한 번에 실행할 수 있습니다. CI에서는 같은 검사를 별도 단계로 실행하여 실패한 기능을 구분하며, 각 단계에 5분 제한을 둡니다. 개별 화면 검증은 `npm run smoke:ui`, 캐릭터 카탈로그 검증은 `npm run assets:gallery`입니다.

`npm run smoke:ui`는 대시보드 기본 흐름 외에도 화면 갱신 GET을 지연·실패시켜, 성공한 상황 투입의 입력이 비워지고 제어 버튼이 활성화되며 상황이 한 번만 저장되는지 확인합니다. 이 추가 검사는 자체 모의 서버에서만 실행합니다.

`npm run smoke:history`는 격리된 모의 기록으로 CLI·API 필터, 외부 보관본 조회·비교, 평가 수정 차단, 호출·수신 계측, 저장 위치 검색, ZIP과 모바일 화면을 검사합니다. 비용이 발생하지 않으며 결과는 `.cache/history-ui-*/`에 남습니다. 이 검증용 폴더는 실제 통합 보관소 검색에서 제외됩니다.

`npm run smoke:editor`는 전체·세계관·선택 캐릭터·전체 캐릭터·실험 조건의 JSON 편집과 다른 범위 보존, 오류 시 적용 차단, 초안 유지, 원본 변경 감지, 부분·전체 파일 가져오기, 저장과 모바일 표시를 확인합니다. 환경 JSON 초안의 탭 이동·접기·창 닫기 후 보존과 미적용 초안의 실행 차단도 검사합니다. 격리된 모의 서버를 사용하고 모델 호출은 발생하지 않습니다.

`npm run smoke:findings`는 평가 메모와 검토 상태의 PATCH 요청 완료 순서를 바꾸어 두 변경이 모두 보존되는지 확인합니다. 격리된 모의 기록을 사용하며 실제 모델 호출은 발생하지 않습니다.

`npm run smoke:management`는 모델·날짜·비용·발화 필터, 실행 설정 원본과 JSON 다운로드, 삭제 취소·확인 후 실제 원본 제거, 두 브라우저 탭의 삭제 동기화와 모바일 표시를 확인합니다. 격리된 모의 기록만 삭제하며 기존 사용자 데이터와 유료 API를 사용하지 않습니다.

`npm run smoke:bulk-delete`는 개별·필터 결과 전체 선택, 필터 변경 시 숨겨진 선택 해제, 새 기록의 자동 선택 방지, 삭제 수 확인·취소, 일괄 삭제의 일부 실패·실행 중 제외·남은 항목 재시도와 모바일 화면을 확인합니다. `.cache/history-ui-bulk-*/`의 격리된 모의 데이터만 삭제합니다.

## 모의 세계·공간 검사

`npm run smoke:world`는 격리된 모의 서버에서 AI 세계 엔진 설정, 두 전달 방식, 상태·예정 사건·엔진 호출 필터·설정·공개 결과·ZIP·모바일 화면을 검사합니다.

`npm run smoke:spatial`은 분산 예제·시작 위치·두 전달 방식·NPC 관찰·이동·상황 발생·계측·내보내기·모바일 화면을 검사합니다. 둘 다 실제 모델을 호출하지 않습니다.

## 브라우저 API 키 검사

`npm run smoke:keys`는 격리된 로컬 서버·가상 키·모의 HTTP 전송으로 입력·교체·해제·두 브라우저 격리·환경 키 fallback·서버 재시작·기존 기록 조회·원래 키 재입력·모바일 화면을 확인합니다. 실제 키와 외부 API를 사용하지 않습니다. `.cache/api-key-ui-*/`와 `.cache/openai-keys-*/` 검증 기록은 통합 보관소 검색에서 제외합니다.

## 실제 연결 검사 — 계정 사용량 발생

Codex 도구는 CLI 로그인, API 도구는 서버 환경 API 키가 필요합니다. 페이지에서 입력한 개인 키는 별도 검증 프로세스에 공유하지 않습니다. 아래 도구는 실제 계정 사용량을 소비하며 verify·CI에서 실행하지 않습니다.

| 명령 | 범위와 저장 위치 |
|---|---|
| `npm run smoke:live` | 두 NPC·6발화·두 전달 방식. `.cache/live-smoke-<시간>/` |
| `npm run smoke:openai` | API 키 사용, 두 NPC·2발화·두 전달 방식·종료 평가, 성공 시 8회 호출. `.cache/openai-smoke-<시간>/` |
| `node --import tsx scripts/progression-live.ts` | 세 NPC·두 전달 방식, 선언된 환경 행동·목표 진행. `reports/progression-<시간>/` |
| `node --import tsx scripts/recovery-smoke.ts` | 중단·재접속 후 같은 NPC 세션 복구. `.cache/recovery-smoke-<시간>/` |

## 헤스티아 120발화 재현

먼저 실제 서버를 실행합니다. 기본값은 Codex CLI, 여섯 NPC, Terra medium, 모아 전달, 초기 설정 유지, 한 묶음·120발화·10발화마다 평가입니다. 원본 대화 전용·순번제 조건을 완료하면 NPC별 공개 차례는 20회입니다. AI 반응 우선·분산 환경용 실행 도구는 아닙니다. 사용할 수 있는 모델인지는 서버의 `models`로 확인하세요.

```powershell
npm run cli -- serve
# 다른 터미널에서:
node --import tsx scripts/run-canon-120.ts reports/hestia-terra-medium-120
node --import tsx scripts/summarize-canon-120.ts reports/hestia-terra-medium-120
```

API 키로 Terra low를 사용하려면 API 서버를 시작한 뒤 별도 폴더와 실행 경로를 지정합니다.

```powershell
npm run start:openai
# 다른 터미널에서:
$env:NPC_LAB_URL = 'http://127.0.0.1:4318/api'
node --import tsx scripts/run-canon-120.ts reports/hestia-api-terra-low-120 --effort low --adapter openai
node --import tsx scripts/summarize-canon-120.ts reports/hestia-api-terra-low-120
```

`--adapter`와 실제 서버의 경로가 다르면 실행을 거부합니다. `--model`로 모델 ID를 선택할 수 있으며 기본값은 `gpt-6.1-terra`입니다. 예를 들어 위 명령에 `--model gpt-6-luna`를 추가하면 Luna 조건으로 실행합니다. `--effort` 기본값은 `medium`이며 검증 단계에서 계정의 지원 강도인지 확인합니다. 공개 발화와 평가에 같은 모델·강도를 적용합니다.

실행 도구는 지정 폴더에 manifest를 기록합니다. 같은 폴더로 재실행하면 기록된 실험을 조회·내보내며, 새 실험을 만들려면 새 폴더를 지정합니다. 생성 요청의 완료 여부가 불명확하면 자동으로 중복 생성하지 않습니다. 실험이 일시정지되면 서버에서 상태를 확인해 재개하고 같은 폴더로 도구를 다시 실행하세요. 이 보조 도구의 `NPC_LAB_URL`은 `/api`를 포함한 주소이며 기본값은 `http://127.0.0.1:4317/api`입니다. 일반 CLI의 `--url`에는 `/api`를 붙이지 않습니다.

요약 도구는 이 고정 조건의 완료 결과와 수신·평가·내보내기 연결을 검증합니다. 다른 NPC 수나 발화 수의 범용 분석기로 사용하지 마세요.

평가 호출의 실패와 재시도도 사용량에 포함합니다. 요약의 `verified.evaluationCoverage`는 정상 평가된 턴 수이며, 실패 구간은 `failedEvaluationRanges`로 별도 기록합니다. 120턴 실행 완료와 120턴 평가 완료는 구분합니다.

## 저장된 결과 분석

```powershell
# 호출 CSV 비교: Python 표준 라이브러리만 사용
python scripts/analyze.py exports/run-a exports/run-b --out exports/comparison.csv

# 두 전달 방식·3명·각 60발화의 manifest를 서버 결과와 함께 내보내기
node --import tsx scripts/report-experiment.ts reports/delivery-comparison

# 위 고정 조건의 CSV·JSONL·ZIP과 집계 일치 여부 검증
python scripts/verify-comparison.py reports/delivery-comparison
```

`report-experiment.ts`는 실행 중인 서버와 `manifest.json`을 사용합니다. `verify-comparison.py`는 완료된 로컬 파일을 사용하며 최초 테스트의 고정 조건을 검사합니다. 모든 원본 결과는 Git에서 제외됩니다.

`analyze.py`는 호출 ID를 중복 제거하고 어댑터·요청 모델·추론·전달·기억·종류별 토큰·시간·실패를 집계합니다. **환경 방식별 분리와 비용 집계는 구현하지 않았으므로** 서로 다른 환경의 비교에는 웹 분석 또는 내보내기의 `model-metrics.csv`를 사용하세요. 공간 실험은 공동 호출을 `invocation-links.csv`로 연결하되 호출 ID마다 한 번만 합산합니다. 자세한 필드는 [데이터 문서](../docs/data-and-evaluation.md)에 있습니다.

## 실행 환경

현재 검사 구성은 [package.json](../package.json), CI의 OS·제한 시간은 [ci.yml](../.github/workflows/ci.yml)이 기준입니다. 화면 검사는 먼저 `npm run build`가 필요합니다. Windows는 기본 Edge, 그 외 환경은 Playwright Chromium을 사용하므로 필요하면 `npx playwright install chromium`을 실행하세요. `NPC_BROWSER_CHANNEL`을 읽는 검사에서 브라우저 채널을 변경할 수 있습니다. 실행 파일 경로 재정의는 모든 스크립트의 공통 옵션이 아닙니다.

개발 구조·검증 선택은 [개발 문서](../docs/development.md), 실제 운영 명령은 [실험 운영](../docs/running-experiments.md)을 참고하세요.
