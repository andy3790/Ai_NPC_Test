# 개발 구조와 검증

Node.js 24 이상을 사용합니다. 공통 설정은 schemaVersion 1, 앱 버전은 [version.ts](../src/shared/version.ts), 프롬프트 버전은 [prompts.ts](../src/core/prompts.ts)에서 관리합니다. 실행 순서는 [운영 문서](running-experiments.md), 외부 연동은 [HTTP API](api.md)에 있습니다.

## 디렉터리와 책임

| 경로 | 역할 |
|---|---|
| src/adapters/ | Codex app-server, OpenAI Responses, Mock. 세션·호출·사용량·복구 인터페이스와 메모리 전용 개인 API 키 저장소 |
| src/core/engine.ts | 실행 생성·스케줄·호출·전달·평가·제어 |
| src/core/store.ts | SQLite 저장·트랜잭션·설정·원본 이벤트 |
| src/core/prompts.ts | NPC·수신·평가 입력과 버전 |
| src/core/director.ts | 진행자 관찰 범위·최근 입력 길이 제한·독립 정책 버전 |
| src/core/progression.ts, quality.ts | 사전 규칙 상태·목표와 반복 품질 |
| src/core/world.ts | 단일 공간 세계 엔진 상태·출력 검증 |
| src/core/spatial-runner.ts, spatial-state.ts | 분산 가상 시간·선택·활동·복구 |
| src/core/spatial-prompts.ts, perception.ts | 관찰 범위와 공간별 모델 입력 |
| src/core/situations.ts, single-room-situations.ts | 선택형 상황 제안·검토 |
| src/core/simulation-host.ts | 분산 실행과 공통 엔진 사이 계약 |
| src/core/metrics.ts, pricing.ts | 사용량 귀속·통계·환산 비용 |
| src/core/summary.ts, detail.ts | 공통 목록 요약·상세와 캐시 |
| src/core/history.ts, deletion.ts | 외부 기록 읽기 전용 통합·확인 후 실제 삭제 |
| src/core/export.ts, invocation-links.ts | 분석 파일·공동 호출 연결 |
| src/shared/ | Zod 스키마·공통 타입·설정 부분 편집·필터·스냅샷·예제 |
| src/server/ | 로컬 Fastify API·SSE·정적 웹·프로세스 잠금 |
| src/web/App.tsx, features/, hooks/, shared/, api/ | 대시보드·편집·비교·기록·제어·세계 상태 UI |
| tests/, scripts/ | 단위·통합 테스트, 화면 검사, 실제 실행 및 분석 도구 |
| examples/, assets/npc-canon/ | 설정 예제와 정본 캐릭터 팩 |
| data/, exports/, reports/, .cache/ | 로컬 실행·분석 산출물. Git 제외 |

기존 단일 파일 웹 구성은 기능별 모듈로 나뉘어 있습니다. 목록 조회는 원문 전체를 읽는 상세 응답과 분리하며 변경된 실행의 요약 캐시를 무효화합니다. SSE 알림으로 목록을 갱신하고 현재 선택·비교 대상만 상세 재조회합니다.

## 실행과 저장의 경계

실험 설정을 정규화·검증하고 조건×반복마다 원본 spec·variant·최종 NPC 설정을 스냅샷으로 저장합니다. 요청 모델·추론은 실행 중 고정합니다. 호출마다 input/output, 작업 키, 시도·재시도 관계, adapter/thread/turn, 원본 이벤트를 남깁니다.

대화는 정상 구조 검증된 출력만 확정합니다. 수신 대상과 receipts를 저장한 뒤 전달하며 같은 NPC에 동시 요청을 보내지 않습니다. 수신 성공을 보존해 실패 대상만 복구합니다. 서버 재시작은 기존 진행 상태를 일시정지로 돌리고 미확정 호출을 대조합니다. “네트워크 오류이므로 아직 실행되지 않았다”고 가정해 자동 재전송하지 않습니다.

분산 실행은 선택 시작·완료, 시간 계획, 결과 적용, 제안 검토를 체크포인트로 구분합니다. 상태 변경과 공개 결과 발행은 트랜잭션으로 함께 저장합니다. 미래의 활동 결과와 현재의 선택을 섞지 않으며 내부 예정 정보를 NPC에게 노출하지 않습니다.

외부 기록 DB는 Engine에 직접 연결하지 않고 읽기 전용으로 가져옵니다. Engine 생성자의 복구 절차가 과거 외부 실행 상태를 바꾸지 않게 하기 위함입니다. 보관 요약은 파생값만 갱신할 수 있고 원래 입력·출력·설정은 유지합니다.

## 모델 입력과 평가 경계

NPC는 공통 세계·본인 프로필·실제로 수신한 관찰을 받습니다. 평가자는 전체 원본과 인지 범위를 사용합니다. 진행자·세계·상황 역할에는 비공개 프로필을 주지 않습니다. 엔진은 실제 발생한 비공개 채널 발언을 볼 수 있으나 그것을 다른 NPC에게 자동 공유하지 않습니다.

진행자는 `Engine.direct`를 통해 호출 시도마다 새 세션을 생성합니다. 같은 helper 슬롯에는 최신 세션 포인터만 남기며, 이전 thread/turn과 계측은 호출 원장으로 보존합니다. 세션 생성 전에 operationKey로 완료·미확정 상태를 확인합니다. 재시도에서 이전 입력을 참조하는 축약 요청은 같은 thread에만 허용하며, 새 진행자 세션에는 제한된 원본 입력을 전달합니다. 입력 한도·관찰 개수·생략 여부와 `director/1` 정책 버전은 `metadata.directorContext`에 기록합니다. [입력 정책](running-experiments.md#ai-진행자의-입력-범위)의 120차례·최대 길이·API 응답 연결·복구 검증은 `tests/director-context.test.ts`에 있습니다.

구조 검증은 모델의 자연어가 의미상 항상 설정을 준수한다는 보장이 아닙니다. 새 제약을 추가할 때는 출력 스키마·적용 검증·프롬프트·회귀 테스트를 함께 확인하세요. 평가가 NPC 응답을 교정하거나 평가 내용을 NPC에게 보내지 않도록 유지합니다.

## 개발 명령과 검사

```powershell
npm ci
npm run typecheck
npm test
npm run build
npm run verify
npm run verify:ui
```

verify는 typecheck·전체 테스트·build·팩 검증·팩 모의 실행·공개 검사를 포함합니다. verify:ui는 빌드된 웹을 사용하며 대시보드·부분 편집·보관·평가 검토·필터/설정/삭제·일괄 삭제·세계·분산 공간·브라우저 API 키·카탈로그를 검사합니다. 상세 명령·브라우저 조건은 [스크립트 문서](../scripts/README.md)에 있습니다. CI 구성은 [ci.yml](../.github/workflows/ci.yml)이 기준입니다.

두 검증은 실제 모델을 호출하지 않습니다. `smoke:live`, `smoke:openai` 등 실연결 도구는 별도 실행이며 사용량을 소비합니다. 모의 검증 통과를 실제 NPC 캐릭터성·세계관 품질의 증거로 사용하지 마세요.

개발 서버 `npm run dev`는 TS 서버를 실행합니다. 웹은 dist/web 정적 산출물을 제공하므로 프런트 수정 후 build가 필요합니다. 빌드된 서버를 실행 중이라면 서버 코드 변경도 재시작해야 반영됩니다. 실행 기록의 백업·정지는 [기록 관리](run-management.md)를 따릅니다.

## 변경 시 함께 확인할 곳

| 변경 | 함께 검토 |
|---|---|
| 설정 필드 | schema·공통 타입·폼·부분 JSON 범위·예제·변환 프롬프트·JSON 가이드 |
| 프롬프트 | 버전·비공개 격리·기억 방식·모의/실제 출력 규격·팩 호환 해시 |
| 호출 종류 | adapter·계측·요약·필터·비용·내보내기·보관 요약 갱신 |
| API 모델 | 계정 목록과 능력표의 교집합·구조화 출력·effort·공식 규격. 단가는 별도로 검증 |
| API 키 | 브라우저별 선택·실험/세션의 출처 고정·모든 보조 역할·재시작 복구·원문 비저장·오류 가림. openai-keys 테스트와 smoke:keys |
| 가격 | pricing.ts의 날짜·출처·정확한 모델 ID·가정 표시·과거 파생 요약 |
| 세계 상태 | 공간 관찰·시간 경계·반응 기회·중단·복구·트랜잭션 |
| 영구 삭제 | 경로 검증·잠금·선택 변경·부분 실패·다른 실행 보존 |
| 내보내기 | 공통 ID·null·단위·공동 호출 중복 방지·동봉 데이터 사전 |

토큰 합계에 캐시·추론 부분을 다시 더하지 말고, 병렬 호출 시간 합계를 실제 경과 시간으로 표시하지 마세요. 고정조건 분석 스크립트는 일반 공간 실험 분석에 그대로 적용할 수 없습니다.

## 문서 유지보수

[문서 목차](README.md)에 각 설명의 소유 문서를 정리했습니다. 변환 프롬프트는 txt 한 파일만 관리합니다. export.ts의 동봉 데이터 사전은 저장소 없이 읽을 수 있어야 하므로 핵심 집계 규칙을 유지합니다.

캐릭터 팩은 build.mjs로 생성합니다. 스키마·프롬프트 변경 후 `npm run assets:build`, `npm run assets:validate`로 해시와 호환성을 갱신하되 정본 원문·캐릭터·이미지를 기능 변경에 끌려 바꾸지 마세요. 과거 실험 보고서와 ZIP은 생성 당시 기록으로 보존합니다.

문서 편집 후에는 상대 링크·헤딩 앵커·npm 명령·예제 JSON을 확인합니다. 필드 설명은 코드와 일치시켜야 하며 제안된 기능을 이미 구현된 기능처럼 쓰지 않습니다.
