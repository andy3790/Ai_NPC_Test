# 모델 목록·추론 강도·단가 관리

앞으로 모델을 추가하거나 선택 목록에서 제외하고 가격을 바꿀 때는 **[src/config/models.json](../src/config/models.json) 한 파일**을 수정합니다. 기존 Responses API 호출 형식 안에서 모델 데이터만 바꾸는 작업에는 코드 수정·빌드·전체 회귀 테스트가 필요하지 않습니다.

## 반영 절차

1. 실행 중인 실험을 마치거나 일시정지합니다.
2. `src/config/models.json`에서 필요한 항목을 수정하고 저장합니다.
3. 기존 서버를 종료하고 같은 실행 명령으로 다시 시작합니다. API 서버는 `npm run start:openai`입니다. **다시 빌드하지 않아도** 서버가 원본 JSON을 읽습니다.
4. 페이지를 새로고침합니다. 브라우저도 서버의 모델·가격 데이터를 받아 사용하므로 웹 빌드를 다시 할 필요가 없습니다.

서버 시작 시 JSON 형식, 중복 모델 ID, 필수 단가, 음수·무한대 가격, 추론 강도와 기본값의 일치 여부를 자동 검사합니다. 오류가 있으면 경로와 문제 항목을 표시하고 시작을 중단합니다. 먼저 확인하고 싶을 때만 `npm run models:check`를 실행하세요. 모델 호출·API 키·전체 회귀 테스트 없이 설정만 검사합니다.

페이지에서 입력한 개인 키는 서버 메모리에 있으므로 재시작 후 다시 입력해야 합니다. `.env` 키는 기존 방식으로 다시 불러옵니다. 저장된 실험의 모델을 자동 교체하지 않으며, 기존 실험을 이어서 실행할 때도 원래 모델의 실제 사용 권한이 필요합니다.

## 모델 한 항목의 형식

아래는 형식을 설명하기 위한 가상 모델입니다. 실제 모델 ID, 추론 지원 범위, 공식 단가로 바꿔 `models` 배열에 추가하세요.

```json
{
  "id": "your-model-id",
  "name": "표시 이름",
  "enabled": true,
  "api": {
    "efforts": ["low", "medium", "high"],
    "defaultEffort": "low",
    "reasoning": true
  },
  "pricing": {
    "input": 1,
    "cached": 0.1,
    "output": 5,
    "write30m": 1.25,
    "longContext": {
      "aboveInputTokens": 272000,
      "input": 2,
      "cached": 0.2,
      "output": 7.5,
      "write30m": 2.5
    }
  },
  "source": "https://developers.openai.com/api/docs/pricing"
}
```

| 필드 | 의미 |
|---|---|
| `id` | 제공자가 사용하는 정확한 모델 ID. 날짜가 붙은 스냅샷은 별도 항목으로 등록 |
| `name` | 선택 사항인 표시 이름. 실행에는 항상 `id`를 사용 |
| `enabled` | `true`면 선택 허용, `false`면 새 실험의 선택 목록과 검증에서 제외 |
| `api` | OpenAI Responses용 추론 설정. `null`이면 API 선택 목록에 등록하지 않음 |
| `api.efforts` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` 중 실제 지원하는 값 |
| `api.defaultEffort` | `efforts`에 포함되는 기본값 |
| `api.reasoning` | `false`인 비추론 모델은 `efforts: ["none"]`, `defaultEffort: "none"` 사용 |
| `pricing` | Standard 텍스트 요금. 미확인 모델은 `null`로 두면 화면에 **단가 미등록** 표시 |
| `input`, `cached`, `output` | 각각 일반 입력·캐시 입력·출력의 **100만 토큰당 USD** |
| `write30m` | 선택 사항인 30분 캐시 쓰기 단가. 없으면 생략 |
| `longContext` | 장문 요금이 없으면 객체 전체를 생략. `aboveInputTokens`를 **초과**한 요청 전체에 해당 단가 적용 |
| `source` | 선택 사항인 해당 모델의 공식 출처. 없으면 파일 최상위 `pricingSource` 사용 |

파일 최상위 `schemaVersion`은 `1`로 유지합니다. `pricingDate`는 공식 요금을 확인한 날짜(`YYYY-MM-DD`), `pricingSource`는 기본 공식 출처입니다. 모델별 입력·출력·캐시 단가는 모델 선택기와 실행 후 환산 비용에 함께 적용합니다. 일반 사용자 화면에는 입력·출력, 캐시 입력, 장문 입력의 추가 단가가 표시됩니다.

OpenAI API 목록은 **활성 JSON 항목과 계정의 `/models` 목록의 교집합**입니다. JSON 등록만으로 계정 권한을 얻지는 않습니다. Codex CLI의 모델·추론 정보는 기존처럼 app-server에서 조회하며, JSON의 `enabled: false`와 가격을 함께 적용합니다. CLI에서 처음 나타난 미등록 모델은 선택할 수 있지만 단가는 미등록으로 표시합니다.

기존 `NPC_OPENAI_MODELS` 환경 설정은 호환성을 위해 유지합니다. 같은 ID이면 API 능력값은 환경 설정이 우선하며, JSON에서 비활성화한 모델을 다시 활성화하지는 않습니다. 새 모델을 관리할 때는 JSON 한 곳을 사용하는 편이 명확합니다.

## 모델 제외와 과거 기록

목록에서 빼려면 해당 항목을 지우는 대신 **`"enabled": false`로 바꾸세요.** 가격은 그대로 남아 과거 기록의 비용을 계산할 수 있습니다. 항목을 완전히 삭제하면 해당 모델의 과거 비용이 미산정으로 바뀔 수 있습니다.

`gpt-4.1-mini`와 `gpt-4.1-mini-2025-04-14`는 이 방식으로 선택 목록에서 제외했습니다. 공식 문서는 deprecated로 표시하고 API 제거 예정일을 2027-01-14로 안내합니다. [공식 폐기 일정](https://developers.openai.com/api/docs/deprecations)

가격 수정은 현재 화면·새 내보내기·보관 기록의 파생 비용 요약에 적용됩니다. 원본 토큰·대화·이미 받은 내보내기 파일은 유지합니다. 설정 내용으로 만든 `pricingRevision`으로 변경을 감지하므로 `pricingDate`를 바꾸지 않아도 보관 요약이 갱신됩니다. 과거 비용과 비교할 때 날짜·revision·설정 파일을 함께 보관하세요.

## 모델 데이터 변경과 개발 변경의 구분

GitHub에서 `src/config/models.json`과 이 문서만 바뀐 경우에는 무거운 Verify 작업을 생략합니다. JSON이 바뀌면 별도의 **Validate model catalogue** 작업이 `models:check`만 실행합니다. 모델 추가·비활성화·단가 수정 때 회귀 테스트나 유료 연결 검사를 수행하지 않습니다.

새 API 형식·새 제공자·새 추론 매개변수·가격 계산 규칙을 지원하기 위해 코드를 바꾸는 경우에는 기능 개발에 해당하므로 관련 검증이 필요합니다. 설정 검사는 공식 가격의 사실 여부나 계정의 실제 호출 성공까지 확인하는 검사가 아닙니다.
