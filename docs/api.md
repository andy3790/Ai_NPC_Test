# Local API · v1

기본 주소: `http://127.0.0.1:4317/api`. 요청 본문과 응답은 JSON, 다운로드는 ZIP, 이벤트 스트림은 SSE입니다. CLI와 웹 화면이 같은 API를 사용합니다. 변경 요청은 `Content-Type: application/json`을 사용합니다. 오류 응답은 `{ "error": "설명" }`입니다.

| 메서드 | 경로 | 동작 |
|---|---|---|
| GET | `/health` | 서버·어댑터 버전 |
| GET | `/models` | 계정에서 표시되는 모델과 지원 추론 강도 |
| GET | `/example` | 현재 모델 목록을 반영한 예제 설정 |
| GET / PUT | `/config` | 마지막 편집 설정 조회 / 저장 |
| POST | `/validate` | 본문의 ExperimentSpec 구조와 모델·추론 검증 |
| POST | `/experiments` | `{spec: ExperimentSpec, start: boolean}`로 묶음 생성 |
| GET | `/runs` | 묶음 목록과 요약 |
| GET | `/runs/:id` | 설정·세션·발화·호출·수신·평가·요약 전체 |
| POST | `/runs/:id/pause` | 현재 발화·전달 경계에서 일시정지 |
| POST | `/runs/:id/resume` | 상태 대조 후 재개 |
| POST | `/runs/:id/step` | 한 공개 발화 및 수신 처리 후 정지 |
| POST | `/runs/:id/stop` | 중단 요청 |
| POST | `/runs/:id/inject` | `{text: string}`의 공개 상황 투입, 일시정지 상태 필요 |
| POST | `/runs/:id/evaluate` | 미평가 구간과 실패한 평가 재시도 |
| PATCH | `/findings/:id` | `{review: "unreviewed" | "confirmed" | "dismissed", note: string}` |
| GET | `/analysis?runIds=id1,id2` | 선택한 묶음의 모델·추론·전달·기억·호출 종류별 집계 |
| GET | `/runs/:id/export` | `{파일명: 텍스트}` 내보내기 객체 |
| GET | `/runs/:id/export.zip` | 분석 파일 ZIP 다운로드 |
| GET | `/events` | 변경 알림 SSE. 알림 후 관련 묶음을 다시 조회 |

기본 타입은 `src/shared/types.ts`, 설정 및 출력 검증 스키마는 `src/shared/schema.ts`가 정의합니다. `schemaVersion`은 1이며, 상세한 설정 예시는 `examples/`에 있습니다. 실행 설정은 생성 시 복사·해시 처리되어 이후 편집 설정과 분리됩니다.

v1.1 추가 설정은 `scenario.environment`(생략 가능)와 `evaluation.repetitionWindow/repetitionThreshold/repetitionMinChars`입니다. 기존 v1 파일은 그대로 읽습니다. 환경의 초기 상태, 행동 조건·효과·공개 결과, 목표 조건은 모두 생성 시 고정됩니다. `enabled`로 사용 여부를, `stopOnGoals`로 목표 달성 시 종료 여부를 선택합니다.

`/runs/:id`와 목록 요약의 `summary.quality`에 `repetition`(어휘 반복률·비교 근거), `semanticRepetition`(AI 의미 반복 지적률), `progression`(목표별 달성·최초 달성 순번·공개 상태)이 추가됩니다. 규칙 미정의 시 progression은 null입니다. 실행 도중 재계산하며 과거 저장값을 덮어쓰지 않습니다. 각 평가 레코드의 `quality`는 평가 시점까지의 어휘 반복·목표 상태 스냅샷입니다. 기존 평가에는 이 필드가 없을 수 있습니다.

NPC 발화의 `actionId`는 행동 요청이며, 이어지는 `kind:event`의 `resolution`이 실제 결과입니다. `resolution.sourceUtteranceId`, `actorId`, `before/after`로 상태 변경을 추적합니다. `/inject` 텍스트만으로 구조화 상태가 변경되지는 않습니다. `run.completionReason`은 `goals_achieved` 또는 `utterance_limit`이며 기존 실행은 없을 수 있습니다. 추가 내보내기 파일은 `quality.json`, `repetition.csv`, `goals.csv`입니다.

## 상태 의미

- 묶음: queued → running → paused/completed/stopped. paused에서 resume/step 가능. 재시작 후 기존 running/queued는 paused.
- 호출: queued → running → completed/failed/cancelled/uncertain. uncertain은 중복 전송하지 않음.
- 수신: pending → processing → delivered. 실패하면 아직 완료되지 않은 수신만 복구 대상.
- 평가: completed/failed. `contextTruncated`와 `verdict=uncertain`은 별도 표시.

`/events`는 재생 가능한 영구 이벤트 저장소가 아니라 상태 갱신 알림입니다. SSE가 재연결되면 `/runs` 및 선택한 `/runs/:id`를 조회하여 현재 상태를 복원합니다. 원본 Codex 이벤트는 SQLite와 JSONL 내보내기에 보존됩니다.
