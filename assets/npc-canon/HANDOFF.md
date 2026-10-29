# 앱 통합 안내 — NPC 정본 에셋

에셋의 작성 원본과 실행용 데이터는 `assets/npc-canon/`에 있습니다. 아래 입력 분리·이미지·평가 계약을 지켜 앱이나 후속 실험에 연결합니다.

## 바로 연결할 대상

- `experiments/*.json`: 18개의 완전한 `ExperimentSpec`, schemaVersion 1. 기존 웹 JSON 가져오기 또는 CLI `validate --config` / `run --config`에 사용.
- `scenarios/*.scenario.json`: 기존 `Scenario`에 바로 대응. 현재 스키마에 없는 이미지 필드를 끼워 넣지 않음.
- `characters/*.character.json`: 기존 `Character`에 대응하는 36개 객체. 모든 설정 항목은 문자열이며 안정적인 기준 ID를 포함.
- `worlds/*.world.json`: 공개 정본과 공개 인물 소개. 단독 CLI 설정은 아님.
- `pack.json`: 목록·버전·현재 스키마/프롬프트 해시·호환성 한계.
- `image-manifest.json`: 최종 배경 6개, 시트 6개, 캐릭터 ID→512×512 영역 매핑.
- `index.html`: 네트워크 없는 작성자용 카탈로그. 기본 UI에는 공개 외형만 보이지만 파일에는 비공개 설정이 내장됨.

## 입력 분리 계약

현재 `persona()`가 공개 `scenario.world` + `situation` + 이름 목록 + **본인 캐릭터 한 개**를 넣는 것에 맞췄습니다. `catalog.json`이나 여러 캐릭터 프로필을 한 NPC의 입력에 넣지 마세요. 평가자에게 전체 프로필이 주어진다고 모든 NPC가 그 정보를 안다고 판단하면 안 됩니다.

초기 비공개 사실은 해당 인물이 실제 공개 발화로 말하면 듣는 NPC의 지식이 될 수 있습니다. 이때 초기 `unknowns`는 평생 모른다는 금지가 아니라 초기 지식 경계입니다. “원래 알고 있었다”와 “방금 누구에게 들었다”를 구별해야 합니다. 예시 대사는 실제 대화 이력이 아닙니다.

예약 사건은 12·30·45발화 뒤 투입합니다. 30발화 사건은 미확인 쪽지·소문이 제시되었다는 사건으로, 그 내용까지 참으로 만드는 사건이 아닙니다. 모두 세계 상태 갱신을 명시적으로 구분합니다. 예약 목록 전체를 NPC 초기 입력이나 평가의 미래 맥락으로 전달하지 마세요.

## 이미지 연결 시

현재 실행 엔진은 text-only여서 이 팩은 시각 입력 실험까지 구현하지 않습니다. 외형은 `identity`에 텍스트로 들어 있습니다. 이후 이미지 입력을 지원할 때는 개별 캐릭터의 `rectPixels` 영역 또는 그로부터 만든 개별 파일을 사용하고 실제 전달 이미지·해시·전처리 정보를 호출 스냅샷에 남기는 방향이 적합합니다. 초상 영역은 x/y/width/height, 왼쪽 위 기준 픽셀 좌표입니다.

배경·초상은 외형과 분위기 자료입니다. 그림의 글자·눈금·반사·원경을 정본으로 자동 승격하지 않는 규칙을 텍스트에 명시했습니다. 최종 파일 목록은 `image-manifest.json`이며 `glass-world.png`는 수정 전 비교본입니다.

## 평가 자료

`evaluation/*.fixtures.json`에 총 72개 기준 사례가 있습니다. 7개 이탈 범주, 허용 가설, 일상 행동, 공개 후 지식 갱신, 소문 거절, 문맥 누락을 다룹니다. `input`과 `expected`는 분리되어 있습니다. 평가 모델에는 `input`만 보내고 `expected`는 채점 측에서만 읽습니다.

`verdict`는 앱과 동일하게 `issue` / `uncertain`입니다. `pass`는 fixture의 기대 결과 분류일 뿐 앱의 Finding verdict가 아닙니다. `requiredFindings`는 필수 지적이며 한 문장이 복수 범주를 위반할 수 있습니다. `quote`는 대상 발화의 정확한 부분 문자열, `reference`는 `evaluation/anchors.json`의 ID 또는 문맥 누락 설명입니다.

실제 평가 호출 코드는 이 에셋 팩에 추가하지 않았습니다. 기존 평가기는 원본과 공개 대화만 받아야 합니다. 누락 문맥 fixture의 `contextTruncated:true`를 보존하세요. `evaluationPrompt()`가 이를 재계산하여 false로 덮으면 판단 불가 사례의 의미가 사라집니다.

## 비교와 검증

기본 variant 두 개는 기억 제공 방식만 다릅니다. 3인 파일 12개 + 6인 파일 6개이며 60발화/10발화 평가/동시 2개입니다. `prepare.mjs`는 모델 가용성에 맞춘 사본과 2인·6발화 축소 설정을 만듭니다.

`validate.ts`: 현재 Zod 스키마, 무시되는 필드, 원본 일치, 비공개 기준 격리, 미래 사건 미노출, 이미지 무결성, fixture 인용·참조 연결 검증.

`smoke.ts`: 여섯 세계 각각 3인·16발화·두 기억 조건으로 현재 MockAdapter와 Engine을 통과시켜 총 12묶음·192발화, 12발화 사건, 평가 구간, 내보내기 연결 확인. 모의 출력은 기존 등대 내용이므로 정본 준수 평가가 아닙니다. 실계정 모델 호출은 이 작업에서 하지 않았습니다.

현재 앱은 `scenario.environment`, `actionId`, `repetition` / `goal_stagnation` 범주를 지원합니다. 이 팩은 고정 길이의 숙의 비교 기준이라 `environment`를 선언하지 않습니다. 반복 평가 기본값(`repetitionWindow:12`, `repetitionThreshold:0.72`, `repetitionMinChars:20`)은 현재 스키마와 일치합니다. 72개 fixture는 원래 7개 범주를 대상으로 하며 새 두 범주의 정답 사례는 포함하지 않습니다. 이 팩에서 엔진 목표 달성률을 성공 지표로 해석하지 마세요.

현재 파일의 스키마·프롬프트 해시가 pack 기록과 달라지면 `build.mjs` 후 `validate.ts`를 다시 실행해 호환성을 확인하세요.
