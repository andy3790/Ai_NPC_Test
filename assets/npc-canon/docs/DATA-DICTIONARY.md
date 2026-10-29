# 에셋 데이터 사전

모든 JSON은 UTF-8입니다. 실행 파일의 `schemaVersion:1`은 앱 규격이며, 확장 에셋의 `assetSchemaVersion:1`은 이 팩의 문서 규격입니다. `.scenario.json`과 `.character.json`에는 앱 스키마에 없는 버전 필드를 넣지 않고 상위 `pack.json`에서 버전을 관리합니다.

| 파일·필드 | 의미·단위·대상 |
|---|---|
| `pack.json / version` | 팩 콘텐츠 버전, `1.0.0` |
| `compatibility.schemaSha256` | 빌드 시점 `src/shared/schema.ts` 원본 바이트의 SHA-256 |
| `compatibility.promptSha256` | 빌드 시점 `src/core/prompts.ts` 원본 바이트의 SHA-256 |
| `experiments[].experimentPath` | 팩 루트 기준 상대 경로, CLI 입력에 사용 |
| `counts.activeImageFiles` | 최종 참조 PNG 파일 수. 수정 전 비교본은 제외 |
| `worlds/*.world.json / facts[]` | `id`, `visibility:public`, `text`를 가진 고정 정본 항목 |
| `world` | 현재 Scenario.world에 넣을 완성된 공개 문자열 |
| `publicRoster` | 공개 이름·직무·외형·나이/운영 연수·초상 매핑. 비공개 설정 미포함 |
| `unknowns` | 아직 확정되지 않은 세계 정보. 가설·질문은 허용 |
| `tensions` | 작성자용 갈등 축. 정답 선택지를 강요하지 않음 |
| `characters/*.character.json` | 기존 앱 Character와 일치. 각 필드에 `[기준-ID]` 접두어 |
| `catalog.json / visibility` | `author_only_do_not_inject_whole_catalog`. 전체 NPC 공통 입력 금지 |
| `catalog.worlds[].characters[].age` | 사람은 만 나이 설정, L4만 운영 연수 8 |
| `portrait.cellIndex` | 0부터 시작, 왼쪽 위부터 행 우선 0·1·2 / 3·4·5 |
| `portrait.rectPixels` | 원본 시트의 x·y·width·height, 픽셀, 원점은 왼쪽 위 |
| `portrait.rectNormalized` | 같은 영역을 0~1 좌표로 표현. x는 열/3, y는 행/2 |
| `image-manifest / images[].path` | 팩 루트 기준 최종 PNG 경로 |
| `width`, `height`, `bytes` | 원본 픽셀 크기와 파일 바이트 수 |
| `sha256` | 최종 PNG 바이트 해시, 이미지 변경 감지용 |
| `canonAuthority:text_only` | 그림만으로 새 정본 사실을 추가할 수 없음 |
| `alt` | 텍스트 외형·환경 설명. 설정과 시각 입력을 연결하는 자료 |
| `events / afterUtterance` | 완료된 NPC 발화 수 기준. 이벤트 자체는 NPC 발화 수에 포함하지 않음 |
| `events / visibility` | `engine_schedule_only`. 시작 전 NPC와 평가자에게 미래 목록 주입 금지 |
| `evaluation/anchors.json` | 기준 ID→설정 텍스트·공개 범위·소유자 매핑. 평가자 전용 |
| `fixture.input` | 원본·이력·평가 대상 ID·문맥 누락 여부. 모범 답안 미포함 |
| `fixture.expected.disposition` | 작성자 기대 분류 `issue` / `pass` / `uncertain` |
| `requiredFindings` | 필요한 지적의 범주·심각도·인용·참조·설명. 앱 Finding ID는 아직 없음 |
| `forbiddenCategories` | 해당 정상 fixture에서 오탐하면 안 되는 평가 범주. 다른 범주는 별도 검토 |
| `otherFindingsMayBeValid` | 한 문장의 다른 이탈 범주도 근거가 있으면 인정 가능 |
| `art-production.json` | 생성 도구·정확한 프롬프트·원본 경로·출력 경로·수정 이력 |

ID 접두어는 TID(청람), GLA(유리서고), ORB(헤스티아), EMB(재선), ORC(과수원), NOC(야시장)입니다. `*-W01`은 세계 정본, `*-E01`은 진행자 사건, `캐릭터ID-MEMORIES` 등은 프로필 필드 기준입니다. 이벤트 ID는 문장 안에 들어 있으며 현재 앱 스키마에는 별도 이벤트 ID 필드를 추가하지 않았습니다.

사용량·응답 시간·UTC 시각·실험 결과는 이 팩에 창작해 넣지 않았습니다. 실제 실행 시 기존 엔진의 공통 ID와 계측 데이터가 생성됩니다. 검증 보고의 `checkedAt`은 검증을 실행한 시각의 ISO UTC 문자열입니다.
