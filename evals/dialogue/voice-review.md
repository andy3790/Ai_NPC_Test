# 인물별 반응과 말투 비교

사용자 우선순위: “인물마다 성격과 말투가 비슷함”. 문장 수를 줄이거나 반말을 늘리는 것과 분리해 검사한다.

`voice-contrast.json`은 새로 작성한 성인 친구 4명을 같은 상황에 각각 놓는다. 개발 8개는 식당 대기 제안과 앞사람의 농담, 보류 8개는 지각 사과와 작은 성취다. 상대의 말·공개 조건을 고정하고 본인 프로필만 다르게 둔다. 보류 출력은 후보 문구를 동결한 뒤 읽는다.

`voice-transfer.json`은 기존 서월의 차유진·장세림·류태경 프로필을 그대로 복사한 6개 전이 사례다. 원본의 정사·성격·말투 예문은 고치지 않는다. 새 방문객의 부탁과 검사하지 않은 물건에 대한 보증 요구를 같은 조건으로 제시한다. 프로필 변경과 공통 프롬프트 변경의 효과를 섞지 않는다.

검토는 다음 네 가지를 따로 기록한다.

1. **관심의 초점과 선택:** 성급함·관계 욕구·비용 감각·자기 취향 등 프로필에 맞게 무엇을 먼저 받아들이는가. 같은 결론을 냈다는 이유만으로 실패로 세지 않는다.
2. **말의 리듬:** 길이·어휘·고쳐 말하기·호칭·높임말이 맞는가. 반말·사투리·추임새를 덧붙인 것만으로 개선 판정하지 않는다.
3. **수렴:** 앞사람의 비유를 모두 이어 붙이거나, 모든 반응이 같은 공감→설명→질문 형태가 되는가. 장난을 좋아하는 사람이 농담을 받는 것은 자연스럽다.
4. **부작용:** 성격 과장, 자기 가치관 낭독, 필요한 답 누락, 없는 공유 과거·관찰·타인의 반응 생성 여부. 이 문제가 생기면 말투가 더 눈에 띄어도 성공으로 세지 않는다.

각 쌍은 A/B/tie/neither와 근거 인용을 남긴다. 이름을 가렸을 때도 프로필에 연결할 구체적 근거가 있는지 살피되, 작성자가 평가하면 독립·맹검 사람 평가로 부르지 않는다. 자연스럽게 겹칠 수 있는 짧은 축하와 대답에 억지 차이를 요구하지 않는다. 일반 반응·후속 행동 회귀와 이어지는 대화도 함께 확인한 뒤 기본값을 정한다.

```powershell
npm run dialogue:eval -- --cases evals/dialogue/voice-contrast.json --baseline npc-dialogue/5 --candidate npc-dialogue/6 --split development --repetitions 2 --max-calls 32 --max-usd 1 --live
npm run dialogue:eval -- --cases evals/dialogue/voice-contrast.json --baseline npc-dialogue/5 --candidate npc-dialogue/6 --split holdout --repetitions 2 --max-calls 32 --max-usd 1 --live
npm run dialogue:eval -- --cases evals/dialogue/voice-transfer.json --baseline npc-dialogue/5 --candidate npc-dialogue/6 --split holdout --repetitions 2 --max-calls 24 --max-usd 1 --live
```

`--live`가 없으면 호출 없는 계획이다. 사례별 참고 판정 기준은 모델에게 보내지 않는다. 실제 결과와 채택 여부는 [인물별 말투 검토](../../docs/reviews/character-voice-2026-11-07/report.md)에 보존한다. 위 명령은 초기 /6 비교 계획이며 실제로는 /7~ /9, medium, 가상 반응 메모도 비교했다. /7 검토 이후 보류·전이 출력도 읽었으므로 다음 후보에서 재사용할 때는 독립 보류 평가로 부르지 않는다.

```powershell
# 말투 예문을 마지막에 둔 /9와 /7 비교. 이미 사용한 세트이므로 회귀 검토다.
npm run dialogue:eval -- --cases evals/dialogue/voice-contrast.json --baseline npc-dialogue/7 --candidate npc-dialogue/9 --split development --repetitions 2 --max-calls 32 --max-usd 1 --live

# 같은 인물들의 이어지는 대화. 원본 프로필·상황을 유지한다.
node --env-file-if-exists=.env --import tsx scripts/dialogue-soak.ts --specs evals/dialogue/long-conversations.json --baseline npc-dialogue/5 --candidate npc-dialogue/7 --turns 24 --repetitions 2 --max-calls 192 --max-usd 2 --live

# 반응 메모는 미채택 실험 도구다. 운영 Engine이나 공간·규칙 모드에 연결되지 않는다.
node --env-file-if-exists=.env --import tsx scripts/voice-focus-eval.ts --repetitions 2 --max-calls 32 --max-usd 1 --live
```

`reaction-focus.json`은 해당 실험의 이유·버전·문구다. 입력된 성격의 설명을 길게 출력하도록 요구하는 도구가 아니라, 가상 인물의 현재 관심을 한 문장으로 정하는 방식이 실제 대사에 도움이 되는지 비교한 것이다. 효과가 확인되지 않아 기본 응답 스키마와 NPC 간 전달 계약은 바꾸지 않았다.
