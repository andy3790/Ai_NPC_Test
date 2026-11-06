# 인물 프로필 비교 · 2026-11-07

앞선 NPC /6~ /9 공통 프롬프트 비교에서 인물성이 안정적으로 개선되지 않아, 공통 정책을 /5로 고정하고 프로필의 `speechStyle`, `exampleDialogue`만 바꾼다. 원본 정사·성격·관계·기억·현재 목표·지식·행동은 변경하지 않는다.

`assets/seowol/profile-versions.json`이 버전과 이유를 관리한다. /1은 현재 생성 프로필, /2는 고유 말투와 예문을 그대로 두고 공통 interaction/4 문단만 제거, /3은 /2에서 고유 말투와 별개 예문을 보강한 후보다. 이 문서를 작성할 때 기본 생성 버전은 /1이다. 채택은 실제 결과 보고서에서 정한다.

`voice-transfer.json`은 이미 사용한 회귀 자료다. `profile-contrast.json`은 다섯 기존 인물을 각각 4개 새 상황에 둔다. 개발 10개는 당연하게 여기는 도움 요구·대신 정한 음악 취향, 보류 10개는 갑자기 붙는 대여 비용·가벼운 호의다. /3 문구는 보류 출력을 읽기 전에 동결한다. 예문과 실제 기억은 구별하고 어느 성격도 반드시 화내거나 거절하도록 정답을 정하지 않는다.

검토에서는 이름·어미만이 아니라 먼저 짚는 대상, 생략하는 부분, 질문하는 이유, 길어지거나 말을 접는 계기가 프로필과 연결되는지 인용한다. 같은 짧은 감사나 모르는 물건에 대한 거절은 자연스럽게 겹칠 수 있다. 필요한 정보·관계의 높임말·지식 경계가 무너지면 표현이 눈에 띄어도 개선으로 세지 않는다. 예문의 문장을 복사하거나 모든 상황을 물건·돈·자립 등의 한 특징으로 바꾸는 것도 부작용이다.

각 쌍은 A/B/tie/neither와 근거를 기록한다. 작성자가 매핑을 알고 평가한 경우 독립·맹검 사람 평가라고 부르지 않는다. 여러 인물에서 반복되는 구체적인 개선과 보류 상황의 반응을 확인하고, 기존 고지서·반송 장면의 이어지는 대화까지 읽은 뒤 기본 프로필을 정한다. 결과에 맞춰 지침·예문·사례를 같은 버전 아래 다시 쓰지 않는다.

```powershell
# 공통 문단 제거만 비교: 24회. --live 없으면 입력 검증과 계획만 출력.
node --env-file-if-exists=.env --import tsx scripts/profile-eval.ts --baseline seowol-profile/1 --candidate seowol-profile/2 --repetitions 2 --max-calls 24 --max-usd 1 --live

# 고유 예문 보강: 개발 40회, 보류 40회. 공통 정책·모델은 동일하다.
node --env-file-if-exists=.env --import tsx scripts/profile-eval.ts --cases evals/dialogue/profile-contrast.json --baseline seowol-profile/2 --candidate seowol-profile/3 --split development --repetitions 2 --max-calls 40 --max-usd 1 --live
node --env-file-if-exists=.env --import tsx scripts/profile-eval.ts --cases evals/dialogue/profile-contrast.json --baseline seowol-profile/2 --candidate seowol-profile/3 --split holdout --repetitions 2 --max-calls 40 --max-usd 1 --live
```

비용 상한은 사용량에 따른 다음 호출 차단이며 마지막 한 호출은 초과할 수 있다. 실패·사용량 누락·예산 도달 시 자동 재요청하지 않는다. 실행 폴더에 프로필 구성 전체, 그 해시, 완전한 실효 입력·출력·사용량·비교 순서를 보존한다.

## 결과와 추가 실험

[검토 보고서](../../docs/reviews/profile-voice-2026-11-07/report.md)에 385개 완료 호출과 4개 연속 대화를 보존했다. /2와 /3은 미채택이며 원본 생성 에셋은 /1을 유지한다. `profile-versions.json`은 비교 구성의 기록이다. `current` 필드만 변경해서 운영 프로필을 전환하는 기능은 없다.

`--model`, `--effort`로 별도 모델 표본을 만들 수 있다. 이번 Terra·Astra 비교는 각 1반복이며 모델 일반 순위를 뜻하지 않는다.

추가 틀도 운영에는 넣지 않았다. `--source`에는 완료된 `profile-eval` 폴더를 지정한다. 원본 프로필 해시가 달라지면 유료 호출 전에 중단한다. 기본적으로 계획만 출력하며 `--live`로 실행한다.

```powershell
# /3 초안 중 assumed_help_ 10개의 말투 편집. 원래 action은 코드가 그대로 보존.
node --env-file-if-exists=.env --import tsx scripts/voice-realization-eval.ts --source <profile-eval-folder> --max-calls 10 --max-usd 1

# 같은 관찰을 생활극의 다음 차례로 새로 생성. 대조군은 이전 실행에서 재사용.
node --env-file-if-exists=.env --import tsx scripts/scene-framing-eval.ts --source <profile-eval-folder> --max-calls 20 --max-usd 1
```
