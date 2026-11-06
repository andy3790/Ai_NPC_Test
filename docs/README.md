# 문서 목차와 기준

이 문서는 **앱 1.4.0, 설정 schemaVersion 1, 프롬프트 npc-lab/8**의 구현을 기준으로 2026-11-07에 정리했습니다. 앱 버전, 설정 형식, 캐릭터 자료 팩 버전은 서로 독립적입니다. 과거 실행의 설정·입출력·프롬프트 버전은 새 문서에 맞춰 덮어쓰지 않습니다.

서월 세계관의 실행 프로필과 장면·실제 API 검토 방법은 [서월 실행 팩](../assets/seowol/README.md)을 참고하세요.
반말·신경질·하오체를 쓰는 새 인물의 실제 대화와 문체 수정 비교는 [성격별 문체 실험](seowol-voice-experiments.md)에 있습니다.

## 읽는 순서

| 하고 싶은 일 | 읽을 문서 |
|---|---|
| NPC 말투 개선·버전별 이유 | [프롬프트 변경과 검증](dialogue-prompts.md) |
| 최근 기능 변경 확인 | [변경 이력](../CHANGELOG.md) |
| 처음 설치하고 화면 열기 | [프로젝트 README](../README.md) → [실험 운영](running-experiments.md) |
| API 키로 실행 | [OpenAI API 실행](openai-api.md) |
| 모델 추가·제외·단가 수정 | [모델 설정 관리](model-catalog.md) |
| 시나리오·조건 만들기 | [실험 JSON 가이드](experiment-json-guide.md) → [변환 프롬프트](prompts/requirements-to-experiment-json.txt) |
| 행동 결과·이동·사건 실험 | [세계 엔진·분산 공간](world-engine.md) |
| 기존 기록 조회·비교·삭제·백업 | [기록 관리](run-management.md) |
| 결과 해석·외부 분석 | [데이터·비용·평가](data-and-evaluation.md) |
| 외부 도구에서 실행 제어 | [로컬 HTTP API](api.md) |
| 코드 수정·검증 | [개발 안내](development.md), [스크립트 목록](../scripts/README.md) |
| 소스 공개 | [공개 준비](publishing.md), [보안과 데이터](../SECURITY.md) |
| 제공 세계관·캐릭터 사용 | [자료 팩 안내](../assets/npc-canon/README.md), [자료 목록](../assets/npc-canon/docs/CATALOG.md) |

## 문서의 역할과 통합

실행 절차는 `running-experiments.md`, 설정 필드는 `experiment-json-guide.md`, 세계 진행 원리는 `world-engine.md`에서 관리합니다. 지표·집계는 `data-and-evaluation.md`, HTTP 요청 형식은 `api.md`가 기준입니다. 공통 설명은 담당 문서로 연결합니다.

기존 `spatial-world.md`는 단일 공간 설명과 공통 규칙이 겹쳐 `world-engine.md`로 통합했습니다. JSON 가이드에 중복되어 있던 전체 변환 프롬프트는 `prompts/requirements-to-experiment-json.txt`만 유지합니다. README의 상세 운영·평가·보관 설명도 담당 문서로 옮겼습니다.

## 코드와 생성 문서

| 내용 | 실제 정의 |
|---|---|
| 설정·참조 검증 | [schema.ts](../src/shared/schema.ts), [spatial-schema.ts](../src/shared/spatial-schema.ts) |
| 부분 JSON 교체 | [config-sections.ts](../src/shared/config-sections.ts) |
| 타입·지표·단가 | [types.ts](../src/shared/types.ts), [metrics.ts](../src/core/metrics.ts), [pricing.ts](../src/core/pricing.ts) |
| 모델 목록·추론·공식 단가 데이터 | [models.json](../src/config/models.json) |
| 프롬프트·세계 진행 | [prompts.ts](../src/core/prompts.ts), [spatial-runner.ts](../src/core/spatial-runner.ts), [world.ts](../src/core/world.ts) |
| HTTP·CLI | [app.ts](../src/server/app.ts), [cli.ts](../src/cli.ts) |
| 내보내기 동봉 데이터 사전 | [export.ts](../src/core/export.ts)의 템플릿 |
| 캐릭터 팩의 세계관 문서·JSON·목록 | [build.mjs](../assets/npc-canon/build.mjs)와 팩 원본 자료 |

내보내기 ZIP의 데이터 사전은 저장소 없이도 해석할 수 있도록 자체 설명을 포함합니다. 예전 ZIP·분석 보고서·실행 로그는 당시 결과이므로 문서 갱신 과정에서 수정하지 않습니다. 자료 팩의 생성 문서는 생성기로 갱신하고, 세계관 사실이나 캐릭터 설정은 기능 문서 정리를 이유로 바꾸지 않습니다.
