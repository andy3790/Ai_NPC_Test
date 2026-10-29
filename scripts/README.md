# 검증·분석 도구

모든 명령은 프로젝트 루트에서 실행합니다. 기본 검증은 `npm run verify`이며 실제 모델을 호출하지 않습니다. 화면 검증은 `npm run smoke:ui`, 캐릭터 카탈로그 검증은 `npm run assets:gallery`입니다.

## 실제 Codex 연결 검사

아래 도구는 Codex 로그인이 필요하며 계정 사용량을 소비합니다. CI에서는 실행하지 않습니다.

| 명령 | 범위와 저장 위치 |
|---|---|
| `npm run smoke:live` | 두 NPC·6발화·두 전달 방식. `.cache/live-smoke-<시간>/` |
| `node --import tsx scripts/progression-live.ts` | 세 NPC·두 전달 방식, 선언된 환경 행동·목표 진행. `reports/progression-<시간>/` |
| `node --import tsx scripts/recovery-smoke.ts` | 중단·재접속 후 같은 NPC 세션 복구. `.cache/recovery-smoke-<시간>/` |

## 헤스티아 120발화 재현

먼저 실제 Codex 서버를 실행합니다. 여섯 NPC, Terra medium, 모아 전달, 초기 설정 유지, 한 묶음·120발화·10발화마다 평가로 실행합니다. 이 조건에서 NPC별 공개 발화는 20회입니다. 사용할 수 있는 모델인지는 서버의 `models`로 확인하세요.

```powershell
npm run cli -- serve
# 다른 터미널에서:
node --import tsx scripts/run-canon-120.ts reports/hestia-terra-medium-120
node --import tsx scripts/summarize-canon-120.ts reports/hestia-terra-medium-120
```

실행 도구는 지정 폴더에 manifest를 기록합니다. 같은 폴더로 재실행하면 기록된 실험을 조회·내보내며, 새 실험을 만들려면 새 폴더를 지정합니다. 생성 요청의 완료 여부가 불명확하면 자동으로 중복 생성하지 않습니다. 실험이 일시정지되면 서버에서 상태를 확인해 재개하고 같은 폴더로 도구를 다시 실행하세요. `NPC_LAB_URL`은 API 기본 주소를 지정하며 기본값은 `http://127.0.0.1:4317/api`입니다.

요약 도구는 이 고정 조건의 완료 결과와 수신·평가·내보내기 연결을 검증합니다. 다른 NPC 수나 발화 수의 범용 분석기로 사용하지 마세요.

## 저장된 결과 분석

```powershell
# 일반 내보내기 폴더 비교: Python 표준 라이브러리만 사용
python scripts/analyze.py exports/run-a exports/run-b --out exports/comparison.csv

# 두 전달 방식·3명·각 60발화의 manifest를 서버 결과와 함께 내보내기
node --import tsx scripts/report-experiment.ts reports/delivery-comparison

# 위 고정 조건의 CSV·JSONL·ZIP과 집계 일치 여부 검증
python scripts/verify-comparison.py reports/delivery-comparison
```

`report-experiment.ts`는 실행 중인 서버와 `manifest.json`을 사용합니다. `verify-comparison.py`는 완료된 로컬 파일을 사용하며 최초 테스트의 고정 조건을 검사합니다. 모든 원본 결과는 Git에서 제외됩니다.
