# 로컬 HTTP API

앱 1.4.0 · 설정 `schemaVersion: 1` 기준입니다. 기본 주소는 Codex 서버 `http://127.0.0.1:4317/api`, API 서버 `http://127.0.0.1:4318/api`입니다. 실행 경로가 달라도 HTTP 규격은 같습니다. 서버의 `health.adapter`가 실제 실행 경로를 결정합니다.

JSON 본문이 있는 변경 요청에는 `Content-Type: application/json`을 사용합니다. 본문 한도는 4 MiB입니다. 개인 API 키는 전용 `/openai/key` 엔드포인트로만 설정하며 실험 JSON에는 넣지 않습니다. 서버는 루프백에만 바인딩하고 Host 및 Origin을 검사합니다. 브라우저별 키 선택은 지원하지만 계정 로그인·기록 접근 권한 분리는 없습니다.

일반 처리·검증 오류는 HTTP 400과 `{"error":"설명"}`, 잘못된 Host·다른 Origin은 403입니다. 없는 API 경로는 404입니다.

## 브라우저 개인 API 키

OpenAI API 서버에서만 제공합니다. 키가 없어도 health·config·history·기존 기록 조회는 가능합니다.

| 메서드·경로 | 요청 / 응답 |
|---|---|
| `GET /openai/key` | 브라우저 식별 쿠키 발급 및 `{source,configured,environmentAvailable}`. source는 `browser`, `environment`, `missing` |
| `PUT /openai/key` | `{apiKey:string}`. 최대 4096자. 모델 목록으로 검증 후 이 브라우저의 개인 키를 메모리에 설정하고 위 상태 반환 |
| `DELETE /openai/key` | 개인 키 선택 해제 후 위 상태 반환. 새 실험에 적용하며 기존 실험 키는 유지 |

응답은 `Cache-Control: no-store`이며 키 원문을 반환하지 않습니다. 먼저 GET으로 받은 `npc_lab_browser` 쿠키를 이어서 보내세요. 256비트 난수 쿠키는 HttpOnly·SameSite=Strict·Path=/api이고 키를 포함하지 않습니다. 브라우저 프로필·호스트가 같은 탭은 쿠키를 공유합니다. 쿠키가 없는 요청은 서버 환경 키를 사용합니다.

`models`, `example`, `validate`, `experiments`는 **해당 브라우저의 개인 키 → 서버 환경 키** 순서로 선택합니다. 둘 다 없으면 400과 입력 안내를 반환합니다. 잘못된 새 키는 현재 선택을 덮어쓰지 않습니다. 이미 선택된 개인 키의 호출이 실패했다고 환경 키로 재시도하지 않습니다.

실험 생성 시 선택을 고정합니다. `run.apiCredential`에는 `source:environment` 또는 `source:browser`와 키·브라우저의 해시 식별자만 보관합니다. 키 원문이나 식별 쿠키 원문은 기록하지 않습니다. `/runs/:id/config.json`에는 `apiKeySource`만 추가됩니다. 기존 API 기록에서 이 필드가 없으면 서버 환경 키로 취급합니다.

개인 키 실험의 `resume`, `step`, `inject`, `evaluate`는 원래 브라우저 또는 동일 키를 입력한 브라우저에서 호출합니다. 서버 재시작 시 키 메모리가 비워지므로 원래 키를 다시 입력해야 합니다. 조회·pause·stop·삭제는 기존 로컬 관리자 동작을 유지합니다. CLI는 브라우저 쿠키를 공유하지 않습니다. 사용 절차는 [API 실행 안내](openai-api.md)를 참고하세요.

## 설정과 생성

| 메서드·경로 | 요청 / 응답 |
|---|---|
| `GET /health` | `{ok, adapter, version, historyEnabled}` |
| `GET /models` | 현재 어댑터의 모델 목록. `id, name, efforts, defaultEffort, isDefault` |
| `GET /example` | 서버 모델을 적용한 ExperimentSpec. API 서버는 일반 예제를 6차례·평가 간격 6·동시 묶음/호출 1로 조정 |
| `GET /config` | 마지막 편집 ExperimentSpec 또는 `null` |
| `PUT /config` | 본문 ExperimentSpec 구조 검증·저장 후 정규화된 spec 반환. 이미 생성된 묶음은 변경하지 않음 |
| `POST /validate` | 본문 ExperimentSpec의 구조·모델·추론 검증. `{valid:true,spec}` |
| `POST /experiments` | `{spec: ExperimentSpec, start?: boolean}`. `start:false`는 일시정지 생성, 생략은 실행 시작. `{experimentId,runs}` 반환 |

필드별 규격은 [JSON 가이드](experiment-json-guide.md)를 따릅니다. 전체 스키마는 알 수 없는 키를 제거할 수 있으므로 반환된 정규화 spec을 확인하세요. 부분 JSON 편집은 웹에서 전체 설정에 병합·검증하는 기능이며 별도 PATCH 설정 엔드포인트는 없습니다.

`PUT /config`는 모델 목록까지 확인하는 `POST /validate`와 다릅니다. `models`, `validate`, 일시정지 생성은 발화 추론을 시작하지 않습니다. 실제 모델 사용 가능 여부·문맥 길이·요청 성공까지 보장하지는 않습니다.

## 조회와 내보내기

| 메서드·경로 | 응답 |
|---|---|
| `GET /runs?provider=all` | `RunListItem[]`. provider: `all, real, codex, openai, mock`. real은 Codex+API |
| `GET /runs/:id` | `RunDetail`: run, utterances, invocations, receipts, evaluations, findings, summary, history 등 |
| `GET /runs/:id/config.json` | 해당 실행의 설정·적용 조건·최종 세션·버전·해시 스냅샷 다운로드 |
| `GET /analysis?runIds=id1,id2` | 해당 묶음들의 호출을 어댑터·요청 모델·추론·전달·기억·환경·종류별 집계. 생략하면 전체 |
| `GET /runs/:id/export` | `{파일명: 텍스트}` 객체 |
| `GET /runs/:id/export.zip` | 같은 파일의 ZIP 다운로드 |
| `GET /history` | 통합 보관소·검색 경로·원본별 상태·오류. 꺼져 있으면 `enabled:false` |
| `POST /history/refresh` | 원본 재검색·보관 갱신. 통합 기록 비활성 서버는 거부 |

목록에는 `scenario:{id,name,characterCount}`, `npcConfigs:[{characterId,name,model,effort}]`, `environmentMode`, 요약과 출처가 포함됩니다. 전체 캐릭터·세계관은 상세 `run.spec.scenario`에 보존됩니다. 목록은 상세 대화 본문을 내려주지 않습니다.

상세 필터는 웹에서 목록 메타데이터에 적용합니다. 서버의 `/runs`는 현재 `provider`만 지원하므로 `model`, 날짜·비용 범위를 쿼리에 넣어 필터된다고 가정하지 마세요. 지표 정의는 [데이터와 평가](data-and-evaluation.md), 검색·보관 우선순위는 [기록 관리](run-management.md)에 있습니다.

내보내기 `config.json`은 실행 스냅샷 래퍼입니다. 재사용할 ExperimentSpec은 그 안의 `spec`이며 래퍼 전체를 설정 입력으로 쓰지 않습니다.

## 실행 제어

다음 POST는 변경 후 상세 기록을 반환합니다. 보관 기록은 실행·평가 변경이 불가능하며 원본 저장소 서버에서 제어해야 합니다.

| 경로 | 본문과 의미 |
|---|---|
| `/runs/:id/pause` | `{}`. 안정된 처리 경계에서 정지 |
| `/runs/:id/resume` | `{}`. 미확정 호출 대조 후 계속 |
| `/runs/:id/step` | `{}`. 한 NPC 선택과 필요한 처리 후 정지 |
| `/runs/:id/stop` | `{}`. 중단 |
| `/runs/:id/inject` | `{text,audience?}`. 안정된 일시정지 상태에서만 투입 |
| `/runs/:id/evaluate` | `{}`. 평가가 켜진 실행의 미평가·실패 구간 처리. 진행 작업이 끝난 뒤 사용 |

상황 `text`는 공백뿐인 값을 허용하지 않으며 최대 100000자입니다. `audience` 생략은 전체 관찰입니다.

```json
{
  "text": "휴게실 조명이 잠깐 깜박인다.",
  "audience": {"scope": "locations", "locationIds": ["lounge"], "npcIds": []}
}
```

| scope | 배열 |
|---|---|
| `locations` | 선언 장소 ID만 locationIds에 지정. `ai_spatial`에서만 허용 |
| `npcs` | 참가 NPC ID만 npcIds에 지정 |
| `all`, `none` | 두 배열 모두 비움 |

배열 두 개는 객체에 포함하며 참조·중복·범위 일치를 검사합니다. 사건은 관찰을 추가하며 임의의 위치·규칙 상태를 직접 수정하는 명령이 아닙니다. 분산 선택·환경 결과 복구가 진행 중이면 투입을 거부합니다.

## 평가 검토

`PATCH /findings/:id`에 다음 중 하나 이상을 보냅니다. 생략한 필드는 유지합니다.

```json
{"review": "confirmed", "note": "원본 말투와 다르다는 점을 확인함."}
```

`review`는 `unreviewed, confirmed, dismissed`, `note`는 최대 10000자입니다. 빈 메모 문자열로 메모를 지웁니다. 다른 키나 빈 객체는 거부합니다. AI의 원래 verdict·근거를 덮어쓰지 않습니다. 보관본 검토는 원본 서버에서 변경 후 새로고침합니다.

## 실제 삭제

웹에서 쓰는 동일한 2단계 확인 흐름입니다. 파일 경로를 삭제 본문에 받지 않습니다.

1. `GET /runs/:id/deletion`으로 `allowed, blockers, targets, token`을 확인합니다.
2. `DELETE /runs/:id`에 `{"confirm":true,"token":"미리보기에서 받은 64자리 토큰"}`을 보냅니다.

진행 중 작업, 사용 중 외부 원본, 경로 오류는 거부합니다. 확인 이후 대상 행이나 삭제 가능 상태가 변하면 새 미리보기가 필요합니다. DB 경로는 파일 전체가 아닌 해당 run ID의 행을 뜻합니다.

여러 묶음은 `POST /runs/deletion-preview`에 `{"runIds":["id1","id2"]}`를 보냅니다. 응답은 중복 제거한 `selectedCount, deletableCount, entries:[{runId,plan,error}], token`입니다. 확인한 ID 집합과 토큰으로 `DELETE /runs`에 `{runIds,confirm:true,token}`을 보냅니다.

일괄 결과는 `{results:[{runId,status,error}]}`이며 status는 `deleted, blocked, failed`입니다. 확인 내용이 바뀌면 시작 전에 거부합니다. 실행 중·없는 기록은 blocked, 가능한 기록은 삭제합니다. 여러 DB·파일 전체를 묶는 트랜잭션은 없으므로 일부 성공을 되돌리지 않습니다. 남은 기록은 새 미리보기로 재확인합니다. 삭제 범위·제외 대상은 [기록 관리](run-management.md#삭제와-일괄-선택)를 참고하세요.

## SSE와 상태

`GET /events`는 이름 없는 SSE `data` 메시지를 보냅니다. 연결 시 `{"type":"connected"}`, 일반 변경은 `{runId,at}`, 삭제는 `{type:"deleted",runId,at}`, 키 선택 변경은 `{type:"credentials-changed",runId:"",at}`입니다. 키 알림에는 키·소유자 정보를 싣지 않습니다. 각 브라우저는 자기 쿠키로 `/openai/key`와 모델 목록을 다시 조회합니다. 15초마다 heartbeat 주석을 보냅니다.

알림을 받으면 목록과 해당 상세·비교 대상을 다시 조회하세요. 빈 runId는 기록 재검색 등 전체 갱신입니다. 영구 재생 스트림이나 모델 토큰 스트림이 아니며 Last-Event-ID 기반 복구도 없습니다. 원본 이벤트는 SQLite·JSONL에 별도로 저장합니다.

| 대상 | 상태 |
|---|---|
| 묶음 | queued, running, paused, completed, stopped |
| 호출 | queued, running, completed, failed, cancelled, uncertain |
| 수신 | pending, processing, delivered |
| 평가 | completed, failed. contextTruncated·uncertain verdict는 별도 |

재시작 후 기존 running/queued는 paused로 복구합니다. 확인되지 않은 호출은 자동 재호출하지 않습니다. 단일 공간과 분산 공간의 정지·step 차이는 [실험 운영](running-experiments.md)과 [세계 엔진](world-engine.md)에 있습니다.

## 세계 상태와 공간별 데이터

- `run.worldState`: 가상 시간·확정 사실·지연 사건. 분산 환경은 `spatial`에 위치·통로·활동·재개 체크포인트를 포함합니다.
- `run.eventGeneratorState`: 상황 검토 횟수·제안·채택/거절·이유.
- `utterances[].worldEvent`: 세계 엔진의 관찰 결과. `resolution`은 규칙 모드의 상태 변화입니다.
- `perception`: 발행 당시 가상 시각·장소·대사/행동 수신 대상. `spatialIntent`는 NPC의 통신·이동·중단/계속 선택입니다.
- `knownUtteranceIds`: 선택 전에 실제 전달된 기록 및 자신의 이전 기록. 전달받은 대사·행동 범위는 perception과 함께 봅니다.
- `summary.byKind`: speech, receive, director, evaluation, environment, event_generation의 별도 계측입니다.

상세 응답은 관리자 전체 기록입니다. 웹의 NPC 관찰 필터는 접근 권한 제한이 아닙니다. 공통 타입은 [types.ts](../src/shared/types.ts), 공간·세계 타입은 [spatial-schema.ts](../src/shared/spatial-schema.ts), [world-schema.ts](../src/shared/world-schema.ts)에서 확인할 수 있습니다.
