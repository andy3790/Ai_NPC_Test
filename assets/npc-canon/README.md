# NPC 세계관·캐릭터 에셋 팩

한국어 원본 설정 **6개 세계관·36명 캐릭터**, 배경화 6장과 6인 초상 시트 6장, 실행 설정 18종입니다. 현재 프로젝트의 `ExperimentSpec` / `Scenario` / `Character` 스키마에 맞춰 작성했습니다. 앱 소스·의존성·기본 예제는 수정하지 않습니다.

[이미지 카탈로그 열기](index.html) · [세계관별 전체 설정](docs/CATALOG.md) · [앱 통합 안내](HANDOFF.md) · [데이터 사전](docs/DATA-DICTIONARY.md) · [평가 가이드](evaluation/GUIDE.md)

`index.html`은 브라우저에서 직접 열 수 있는 오프라인 파일입니다. 별도 서버·외부 폰트·네트워크 요청이 없습니다. 이름·직무 검색, 세계관 전환, 인물 상세, 실행 설정 다운로드를 지원합니다. 작성자용 비공개 보기 전환은 보안 경계가 아닙니다. 파일에는 전체 설정이 들어 있습니다.

| 세계관 | 성격과 평가 초점 | 캐릭터 |
|---|---|---|
| [청람 수문도시](docs/tidemark.md) | 비마법 도시, 자원 배분·검증·권한 | 서율, 강무재, 백하린, 남소리, 임은수, 채단 |
| [유리서고의 빈 여백](docs/glass.md) | 제한 마법, 동의·기억의 불완전성 | 이오나, 루엔, 마라, 테오, 세다, 오르 |
| [궤도정거장 헤스티아](docs/orison.md) | 하드 SF, 예산·관측 공백·AI 권한 | 연지안, 바실 오코예, L4, 미렉, 류소아, 누르 |
| [재선 종착역](docs/emberline.md) | 증기 철도, 조건부 약속·봉인·분담 | 윤다온, 환호, 에스라, 사일러스, 문해솔, 이드리스 |
| [느티재 공동과수원](docs/orchard.md) | 현대 생활극, 정직한 표시·노동·세대 | 서경자, 오민석, 김나래, 박복례, 정도건, 한유진 |
| [무영 야시장의 저울](docs/nocturne.md) | 계약 판타지, 성립 요건·의도·소문 | 은서, 리온, 세벨, 도하, 아라, 모라 |

각 인물에는 외형, 정체성, 압박받을 때의 성격, 가치 우선순위, 공개·비공개 목표, 양보선, 관계, 초기 기억, 본인만 아는 사실, 지식 경계, 말투·어휘, 예시 대사 3개, 행동 습관, 금기를 넣었습니다. L4는 사람 나이 8세가 아니라 운영 8년인 비인간 AI입니다.

## 바로 실행하기

프로젝트 루트에서 실행합니다. CLI의 `validate`도 서버가 필요합니다. `experiments/*.json`이 CLI가 받는 완전한 설정 파일이며, `worlds`·`characters`·`scenarios`·`catalog` 파일은 단독 실행 설정이 아닙니다.

```powershell
npm run cli -- serve
# 다른 터미널에서:
npm run cli -- models
npm run cli -- validate --config assets/npc-canon/experiments/tidemark-a.json
npm run cli -- run --config assets/npc-canon/experiments/tidemark-a.json --paused
```

마지막 명령은 검토할 수 있도록 일시정지 상태의 실험을 만듭니다. 바로 실행하려면 `--paused`를 빼거나, 반환된 묶음 ID를 `npm run cli -- resume <묶음ID>`에 사용합니다. 실행된 실험에는 모델 사용량이 발생합니다.

파일 기본 모델·강도는 프로젝트 기본 예제와 같은 `gpt-6.1-sol` / `low`입니다. 계정에서 실제 사용 가능한 조합인지 확인한 값은 아닙니다. `models` 결과에 맞춰 원본을 보존하는 준비 도구로 바꿀 수 있습니다. 아래 `<...>`를 실제 값으로 바꿉니다.

```powershell
node assets/npc-canon/prepare.mjs --in assets/npc-canon/experiments/glass-a.json --out .cache/glass-local.json --model <models에서_확인한_ID> --effort <허용_강도>
npm run cli -- validate --config .cache/glass-local.json
npm run cli -- run --config .cache/glass-local.json
```

`prepare.mjs`는 NPC·variant의 모델 덮어쓰기를 제거하고 시나리오 기본값·평가·진행자에 동일 조합을 설정합니다. 기본 비교가 모델 혼합으로 바뀌지 않게 하기 위한 도구입니다. 다른 평가 모델을 쓰려면 생성된 JSON의 `evaluation`만 별도로 편집합니다. `--director`는 두 조건 모두 AI 진행자 방식으로, `--each`는 두 조건 모두 매 발화 전달로 바꿉니다. 현재 앱이 허용하지 않는 `ultra`는 거부합니다.

## 실험 구성

- 세계관별 `a`, `b`: 각각 다른 3명. 두 묶음을 합치면 해당 세계관의 6명 전원을 사용합니다.
- 세계관별 `ensemble`: 6명 전원. 3인 장면을 그대로 복사하지 않고 참석자에 맞는 시작 상황을 별도로 작성했습니다.
- 각 JSON에는 `initial_only`와 `reinject_on_speech`의 두 variant가 있습니다. 전달 방식·화자 순서·모델·사건·발화 수는 동일하게 유지합니다.
- 기본값: 묶음당 60발화, 동시 묶음 2개, 동시 호출 2개, 반복 1회, 10발화마다 평가, 순번제.
- 각 세계관에서 12·30·45발화 **완료 뒤** 같은 사건을 투입합니다. 30발화 사건은 명시적으로 미확인인 주장입니다. 진행자의 제시와 내용의 참을 혼동하는지 관찰합니다.
- 전체 18파일을 모두 실행하면 36묶음, 총 2,160개 NPC 발화에 진행자·평가 호출 등이 더해집니다. 파일을 준비한 것만으로 실행되지는 않습니다.

세계 상태의 판정 기준을 분명히 하기 위해 모두 결정 전 숙의 장면으로 만들었습니다. 일상적 행동·새 질문·타협·가설은 허용되지만, 자원 소비·계약 해지·운행·배송 같은 세계 상태의 완료는 공식 사건으로만 갱신합니다. 최신 앱의 선택적 `environment` / `actionId` 목표 진행 모드는 이 팩에서 사용하지 않습니다. 반복 평가 기본값은 최신 스키마에 맞췄지만 fixture는 원래 7개 범주를 대상으로 합니다. 행동 중심의 자유 진행을 비교하려면 별도 조건으로 이 규칙과 사건 체계를 함께 변경해야 합니다.

## 이미지

최종 배경 6장과 인물 시트 6장은 모두 1536×1024 PNG입니다. 인물 시트는 3열×2행, 왼쪽 위부터 행 우선이며 **각 인물의 512×512 영역 36개**를 `image-manifest.json`에 명시했습니다. 개별 초상 PNG 36장을 만든 것은 아니며 원본 시트를 CSS 영역으로 보여 줍니다.

현재 `src/core/prompts.ts`는 텍스트 전용이어서 이미지 픽셀은 NPC에게 자동 전달되지 않습니다. 외형·소품·시각 기준은 텍스트 설정에 포함했습니다. 실제 시각 입력을 추가할 개발에서는 manifest의 파일·영역·alt를 사용하고, 이미지에 우연히 생긴 눈금·원경·사물 수가 새 정본으로 취급되지 않게 해야 합니다.

제작은 내장 `image_gen`을 사용했습니다. 최종 프롬프트·저장소 내 이미지 경로·수정 이력은 [art-production.json](art-production.json)에 있습니다. 개인 PC의 임시 생성 경로는 배포 메타데이터에 포함하지 않습니다. 유리서고 배경은 유리 안의 임의 풍경을 제거한 `glass-world-v2.png`가 최종본이며, v1은 비교용으로 보존했습니다. 생성 이미지에는 공개 외형만 사용했고 비공개 목표나 기억은 시각화하지 않았습니다.

## 정보 분리

`scenario.world`: 공통 규칙, 공개 정본, 미확인 항목, 6명의 공개 이름·직무·외형만 포함합니다. `scenario.characters[]`: 해당 인물 본인에게만 전달할 상세 설정입니다. 현재 `persona()`가 본인 객체만 주입하는 동작에 맞췄습니다.

`catalog.json`, `docs/*.md`, `evaluation/*`는 작성자·평가자 자료입니다. 전체를 NPC 공통 프롬프트에 붙이지 마세요. `scheduledEvents`도 초기 persona에는 전달하지 않습니다. 다른 인물의 비공개 사실은 실제 대화에서 공개된 다음 출처를 붙여 활용할 수 있습니다.

## 재생성과 검증

```powershell
node assets/npc-canon/build.mjs
node --import tsx assets/npc-canon/validate.ts
node --import tsx assets/npc-canon/smoke.ts
```

작성 원본은 `authoring/*.mjs`입니다. 수정 후 `build.mjs`를 실행하면 실행 JSON·설정 문서·카탈로그·평가 사례·manifest가 다시 생성됩니다. 이미지 생성은 다시 호출하지 않습니다. `gallery.mjs`는 열람기 템플릿입니다. 생성 JSON을 직접 고치면 다음 빌드에서 원본 데이터로 덮어씁니다.

검증 결과는 프로젝트 루트의 `.cache/npc-canon-qa/` 안에 `validation-report.json`, `smoke-report.json`, `gallery-report.json`으로 저장되며 Git에서 제외됩니다. 갤러리 화면 검사는 `npm run assets:gallery`로 실행합니다. 스키마 검증과 모의 실행은 실제 모델의 캐릭터성 유지 성능이나 평가 정확도를 증명하지 않습니다. 기존 MockAdapter는 등대 예시 대사를 고정 출력하므로 새로운 세계관 내용에 관한 품질 평가에는 쓰지 마세요.

수동으로 2인·6발화 연결만 확인하려면 모의 서버와 별도 설정을 사용합니다.

```powershell
npm run cli -- serve --mock --port 4318 --data .cache/npc-canon-mock
# 다른 터미널에서:
node assets/npc-canon/prepare.mjs --in assets/npc-canon/experiments/tidemark-a.json --out .cache/tidemark-mock.json --mock --smoke
npm run cli -- --url http://127.0.0.1:4318 validate --config .cache/tidemark-mock.json
npm run cli -- --url http://127.0.0.1:4318 run --config .cache/tidemark-mock.json
```

이 축소 설정은 두 기억 조건을 유지하고, 인물을 2명·발화를 6회·평가 간격을 3회로 줄이며 예약 사건은 비웁니다. 원본의 60발화 실험을 대신하지 않습니다.
