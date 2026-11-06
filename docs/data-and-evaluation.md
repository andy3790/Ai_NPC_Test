# 데이터·비용·평가 해석

이 문서는 저장 기록을 비교·분석할 때의 기준입니다. 실행 설정은 [JSON 가이드](experiment-json-guide.md), 보관·삭제는 [기록 관리](run-management.md)를 참고하세요. 모든 모델 호출 시도와 공개된 결과를 구분해 저장합니다.

## 기록 단위와 연결

| 단위 | 주요 필드 / 의미 |
|---|---|
| 실험·조건·묶음 | experimentId, variantId, repetition, runId. 조건×반복마다 독립 기록 |
| NPC 세션 | characterId, threadId, model, effort. API의 threadId는 로컬 세션 ID |
| 발화·사건 | id, sequence, speechIndex, kind, speakerId, speakerName, speech, action |
| 호출 시도 | id, operationKey, attempt, retryOf, kind, threadId, turnId |
| 전달 확인 | id, utteranceId, characterId, status, invocationId, deliveredAt |
| 평가·지적 | evaluationId, utteranceId, category, verdict, review, note |

`sequence`는 NPC 선택과 세계·수동·예약 사건을 합친 기록 순서입니다. `speechIndex`는 NPC 선택 번호이고 대사 없이 행동만 한 선택도 포함합니다. 수신 확인은 대화 기록이 아닌 호출 출력입니다. 분산 공간의 sequence는 저장 순서일 뿐이며 가상 시각이 같으면 실제 장면상 동시에 일어난 선택일 수 있습니다.

발화 생성은 `invocation.utteranceId`, 수신·단일 원인 처리 호출은 `sourceUtteranceId`로 연결합니다. 모아 전달은 여러 수신 기록의 `invocationId`가 같은 발화 호출을 가리킬 수 있습니다.

공간별 시간 계획·결과 처리는 여러 행동을 한 호출에서 다룹니다. `metadata.sourceUtteranceIds`와 `invocation-links.csv`가 이 연결을 표현합니다. **호출 ID로 중복 제거한 뒤 합산**하세요. 발화별 연결 비용을 단순히 더하면 공동 호출을 여러 번 계산할 수 있습니다.

## 여섯 호출 종류

| kind | 포함 |
|---|---|
| speech | NPC 대사·행동 선택. 무발언 행동 포함 |
| receive | 매 발화 전달의 수신 확인. 세계 결과·수동 사건 수신도 포함 |
| director | 다음 화자 선정 |
| evaluation | 독립 평가 |
| environment | AI 세계 결과, 분산 시간 계획·결과 처리, 상황 제안 검토 |
| event_generation | 상황 제안 또는 침묵 판단 |

실패·취소·재시도·불명확한 시도도 각각 남습니다. `operationKey`는 논리 작업, `attempt`와 `retryOf`는 시도 관계입니다. 성공한 발화만 대화에 배포하지만 실패 호출의 확인된 사용량도 총합에 포함합니다.

진행자 호출의 `metadata.directorContext`에는 정책 `version`, `sessionMode: "fresh_per_attempt"`, 관찰 한도 `maxMessages`, 문자열 한도 `maxHistoryCharacters`·`maxInputCharacters`, 후보가 관찰할 수 있는 기록 수 `availableMessages`, 실제 제공한 수 `includedMessages`, 생략 여부 `truncated`, 실제 직렬화 길이 `historyCharacters`·`inputCharacters`를 저장합니다. 길이의 단위는 JavaScript 문자열의 UTF-16 코드 단위이며 토큰 수가 아닙니다. 실제 토큰은 계속 제공자의 usage로 집계합니다. 이 metadata는 호출 원본·JSONL·호출 CSV에 포함되며, 필드가 없는 과거 진행자 호출은 이전 정책입니다. NPC·평가·세계 엔진의 문맥 정책과는 구분해 분석하세요.

환경·평가·진행자·사건·재시도 없는 **3명·6차례** 기준으로 모아 전달은 speech 6회, 매 발화 전달은 speech 6회+receive 12회입니다. 단일 공간 AI는 기본 선택마다 environment가 추가되고 공개 결과의 수신도 발생합니다. 분산 공간은 실제 수신자·공동 계획·시간 경계·상황 검토에 따라 달라지므로 N−1 공식으로 전체 호출 수를 예측하지 않습니다.

## 토큰과 계측 누락

| 필드 | 단위·해석 |
|---|---|
| inputTokens | 보고된 입력 토큰 |
| cachedInputTokens | 입력 중 캐시 읽기 부분 |
| cacheWriteInputTokens | 제공되는 경우 입력 중 캐시 쓰기 부분 |
| outputTokens | 보고된 출력 토큰. 추론 출력 부분 포함 |
| reasoningOutputTokens | 출력 중 추론 부분 |
| totalTokens | 제공자가 보고한 전체 토큰 |

캐시·추론 부분을 total에 다시 더하지 않습니다. Codex는 검증 가능한 thread 누적 카운터 차이를 사용하고, 마지막 모델 요청의 `last`만을 전체 turn 사용량으로 취급하지 않습니다. API는 응답별 `usage`를 사용합니다. 중복 누적 이벤트는 다시 합산하지 않으며 원본 이벤트도 보존합니다.

`usageStatus`는 `reported_cumulative_delta`, `reported_response`, `unknown_baseline`, `counter_discontinuity`, `missing_usage_event` 등 귀속 상태를 남깁니다. 제공되지 않은 수치는 `null`이고 CSV에서는 빈 셀입니다. 0으로 바꾸지 마세요.

합계는 확인된 값만 더합니다. 호출이 없으면 합계는 0, 호출은 있지만 해당 필드가 모두 미제공이면 null입니다. `missingUsage`는 종료된 호출 중 전체 토큰이 없는 수, `pendingCalls`는 아직 queued/running인 수입니다. 총합·평균과 함께 확인해야 합니다. 실제 모델은 확인 가능한 경우에만 `actualModel`에 남기며 null을 모델 변경으로 해석하지 않습니다.

## 현실 시간과 가상 시간

| 필드 | 단위·기준 |
|---|---|
| queuedAt, startedAt, firstOutputAt, completedAt | UTC ISO 8601. 화면은 한국 시간 |
| queueMs | 호출 대기열 등록부터 전송까지 |
| firstOutputMs | 전송부터 첫 출력 관측까지. 순수 추론 시작 시간이 아님 |
| durationMs | 전송부터 완료 관측까지. 네트워크 포함 클라이언트 관측값 |
| deliveryMs | 발화 저장부터 모든 수신 완료까지의 벽시계 시간. 미완료는 null |
| elapsedMs | 묶음 시작 이후 실제 경과 |
| activeMs, pausedMs | 실행 구간 누적 / 일시정지 구간 |
| durationSumMs | 호출 소요 시간의 합. 병렬 호출은 겹침 |
| virtualSeconds, readyAtSeconds 등 | 장면 시작 이후 가상 초. API 응답 시간과 별개 |

호출 경과 시간은 단조 시계로 측정합니다. 재시작으로 정확한 구간을 복원할 수 없으면 timingComplete나 null durationMs로 한계를 남기며 응답 지연 통계에 성공 여부만으로 임의 수치를 넣지 않습니다. 모아 전달의 deliveryMs는 다음 자기 차례나 일시정지 대기를 포함할 수 있습니다. 발화 생성 시간+수신 호출 시간 합계를 전달 완료 시간으로 대체하지 않습니다. 분산 공간의 서로 다른 장소에서 흐른 시간을 합산하지 않습니다.

`medianMs/p95Ms`는 **completed 호출의 durationMs**에 nearest-rank를 적용합니다. `failureRate`는 failed/cancelled/uncertain 시도 수÷모든 호출 시도 수이며 진행 중 시도도 분모에 들어갑니다. `tokensPerSpeech`는 모든 종류의 확인된 토큰÷NPC 선택 수입니다. 발화 생성만 비교하려면 byKind.speech를 사용하세요.

## USD 환산 비용

현재 [models.json](../src/config/models.json)의 단가 스냅샷 날짜는 **2026-11-06**입니다. 공식 [OpenAI API 가격표](https://developers.openai.com/api/docs/pricing)의 Standard 텍스트 요금을 기준으로 등록된 모델만 계산합니다. 숫자는 이 JSON 한 곳에서 관리하며 [pricing.ts](../src/core/pricing.ts)는 계산만 담당합니다. 모델 선택기에도 같은 입력·출력 단가를 표시합니다. 변경 절차는 [모델 설정 관리](model-catalog.md)를 참고하세요.

짧은 문맥의 기본식은 다음과 같습니다. 단가는 100만 토큰당 USD입니다.

```text
일반 입력 = 입력 - 캐시 읽기 - 적용 가능한 캐시 쓰기
비용 = (일반 입력 × 입력 단가
      + 캐시 읽기 × 캐시 단가
      + 캐시 쓰기 × 쓰기 단가
      + 출력 × 출력 단가) / 1,000,000
```

현재 구현은 해당 단가에 30분 캐시 쓰기와 장문 임계값이 있으면 적용합니다. 임계값 272000을 넘는 등록 모델은 입력 비용 2배·출력 비용 1.5배를 적용합니다. CLI turn은 여러 요청을 합칠 수 있어 누적 입력에 장문 기준을 적용한 값은 가정 포함으로 표시합니다.

확인된 실제 모델을 우선하고 없으면 요청 모델 단가를 사용합니다. 미제공 캐시 세부값을 0으로 가정한 경우에도 표시합니다. 신규 모델·스냅샷 ID를 이름 유사성만으로 기존 단가에 매핑하지 않습니다.

| costStatus | 해석 |
|---|---|
| estimated | 등록 단가·관측 사용량으로 환산 |
| assumed | 캐시 세부값 0 가정 또는 CLI 누적 입력의 장문 가정 포함 |
| missing_rate | 모델 단가 미등록 |
| missing_usage | 입력/출력 누락 또는 세부값 불일치 |
| pending | 아직 계측 대기 |
| not_applicable | 모의 실행 또는 미전송 |

묶음 `cost.usd`는 계산 가능한 호출의 부분 합계입니다. `unpricedCalls`는 단가/사용량 부족 수, `assumedCalls`는 가정 포함 수입니다. CSV에서는 `estimatedCostUsd, unpricedCalls, assumedPricingCalls, pricingDate, pricingRevision`을 사용합니다.

CLI 비용은 API 단가로 비교한 환산치이며 Codex 구독 청구액이 아닙니다. API도 크레딧 잔액·세금·할인·실제 처리 등급·지역 가산을 조회하는 청구 기능이 아닙니다. USD만 표시하며 원화 환율 변환은 없습니다. 앱의 단가가 바뀌면 과거 관측 토큰도 새 스냅샷으로 환산될 수 있으므로 분석 시 pricingDate와 pricingRevision을 보존하세요. revision은 설정 내용에서 자동 생성하며, 날짜가 같아도 가격이 달라지면 보관 비용 요약을 갱신합니다.

## 평가와 사람의 검토

별도 평가 세션은 원본 세계관·캐릭터와 해당 시점의 대화·관찰 근거를 검사합니다. 범주는 personality, speech_style, behavior, memory, knowledge, world_contradiction, world_expansion, repetition, goal_stagnation입니다.

설정에 없는 사실 단정과 추측·질문·일상 동작을 구분합니다. 세계 엔진이 확정한 결과는 NPC에게 허용된 관찰 사실로 참조합니다. 분산 공간에서는 실제로 전달된 기록 범위를 고려하며, 다른 장소에서 먼저 나온 대화를 모두 알고 있었다고 가정하지 않습니다.

평가는 설정 간격마다 새 구간을 검사하고 종료 시 남은 구간을 검사합니다. 원본 대화의 앞부분이 `contextCharacters` 문자 한도로 잘리면 `contextTruncated`로 표시합니다. 원본 저장 기록을 삭제하는 것은 아닙니다. 평가 대상과 연결 결과만으로 한도를 넘으면 구간을 나눌 수 있고, 한 대상조차 담을 수 없으면 호출 없이 실패·미평가로 남깁니다. 그래서 평가 호출 수가 단순한 발화 수÷간격과 다를 수 있습니다. 분산 환경의 중간 평가는 앞선 미완료 활동의 결과를 기다릴 수 있고 종료 평가는 아직 없는 결과를 단정하지 않습니다.

지적에는 category, severity(low/medium/high), verdict(issue/uncertain), 대상 발화, 인용, 관련 설정, 설명을 저장합니다. 근거 부족은 uncertain입니다. 사람은 review(unreviewed/confirmed/dismissed)와 note만 변경하고 AI 판단을 보존합니다. 평가는 NPC에게 전달하거나 자동 교정하지 않습니다.

`issueRate`는 기각되지 않은 issue가 하나 이상 있는 **발화 수÷평가된 발화 수**입니다. 지적 개수와 다르며 사람의 확정률도 아닙니다. 첫 이탈 순번과 범주별 지적 수, 평가 범위·누락도 함께 봅니다. 세계 엔진 결과 자체를 독립적으로 채점하는 별도 평가기는 현재 없습니다.

### 어휘 반복과 의미 반복

어휘 반복은 NFKC 정규화·소문자·문장부호 제거 후 문자 3-gram Dice 유사도를 사용합니다. 최근 repetitionWindow NPC 선택 안의 **같은 화자 대사**와 비교하며 minChars 미만의 짧은 말, 행동·사건은 제외합니다. threshold 이상인 비교 가능 발화의 비율이고 분모가 0이면 null입니다.

`quality.semanticRepetition`은 기각되지 않은 AI repetition 지적이 있는 발화 수÷반복 평가를 지원한 프롬프트(npc-lab/2 이상)로 평가 완료한 발화 수입니다. 이전 프롬프트로만 평가한 기록은 반복 평가 분모에 넣지 않습니다. 표현을 바꿔 같은 확인을 반복하는 현상은 어휘 지표가 낮아도 의미 반복일 수 있습니다. 두 비율은 분모도 달라 직접 대체하지 않습니다.

### 목표와 정체

자동 목표 달성은 `rules`의 상태 조건으로만 판정합니다. 캐릭터의 자유 서술 goals나 AI 세계 엔진의 자연어 결과만으로 자동 달성률을 만들지 않습니다. `quality.progression:null`은 미정의이며 0% 실패가 아닙니다.

`achieved`는 현재 상태 충족, `firstAchievedAtSpeech`는 최초 충족 순번(초기 충족=0)입니다. `stalledSpeechCount`는 마지막 확정 상태 변화 이후의 선택 수이며 자동 실패 판정이 아닙니다. 의미상 진행 정체는 AI의 goal_stagnation 지적과 함께 검토합니다.

## 내보내기 파일

CSV는 UTF-8 BOM·인용 형식이고 객체·배열 셀은 JSON 문자열입니다. 공통 ID로 결합하며 계측 누락을 0으로 바꾸지 않습니다.

| 파일 | 내용 |
|---|---|
| records.jsonl | run/utterance/receipt/invocation/evaluation/finding/raw_event 원본 |
| utterances.csv | 대사·행동·관찰 범위·선택·생성/수신/환경 연결 지표 |
| invocations.csv | 모든 호출 시도·입출력·토큰·시간·비용·재시도 |
| receipts.csv | 발화×NPC의 전달 상태 |
| invocation-links.csv | 한 호출과 여러 원인 발화 연결 |
| summary.csv, model-metrics.csv | 묶음 요약 / 요청 모델·추론·전달·기억·환경·종류별 집계 |
| evaluations.csv, findings.csv | 평가 범위·누락·요약 / 지적·사람 검토 |
| quality.json, repetition.csv, goals.csv | 품질 요약 / 어휘 반복 근거 / 규칙 목표 |
| world-state.json, world-timeline.csv | 최종 세계 상태 / 단일 공간 world/committed 이력 |
| spatial-timeline.csv | spatial/ 및 situation/ 원본 이벤트 이력 |
| situations.json | 상황 제안·검토 상태. 미사용은 null |
| config.json | 원본 spec·해당 variant·최종 세션·버전·해시·API 키 출처(apiKeySource)의 스냅샷 |
| transcript.md | 관리자 전체 대화록 |
| data-dictionary.md | 내보내기와 함께 제공되는 필드·단위·집계 안내 |
| history-source.json | 통합 기록 기능을 통한 내보내기에 추가되는 출처 정보 |

API 키 원문은 내보내기에 포함하지 않습니다. config.json의 `apiKeySource`는 `browser`, `environment`, 또는 API 외 경로의 `null`입니다. records.jsonl의 실행 기록에는 개인 키·브라우저의 해시 식별자가 있을 수 있지만 원문 키나 브라우저 쿠키는 없습니다. 이를 이용해 사용량을 추가 가산하지 않습니다.

`utterances.csv`의 environmentTokens/Calls/Cost/DurationSum은 단일 `sourceUtteranceId`로 연결된 호출만 포함합니다. `environmentInvocationIds`와 `sharedEnvironmentCalls`에는 공동 처리가 포함되므로 공간 실험의 총합은 invocations.csv를 기준으로 계산하세요. 직접적인 호출 원문·원본 사용량 이벤트는 records.jsonl에서 확인할 수 있습니다.

전체 내보내기는 다른 장소·귓속말·비공개 프로필도 포함하는 관리자 자료입니다. NPC 관찰 화면과 구분합니다. AI 수신 확인 출력과 내부 이벤트를 공개 대사로 분석하지 마세요.
