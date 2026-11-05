# GitHub 공개 준비

프로젝트 루트에서 검증합니다. Git·Node.js 24 이상이 필요합니다. 이 문서는 공개할 파일과 확인 절차이며 원격 배포 기능을 의미하지 않습니다.

## 검증

```powershell
npm ci
npm run verify
npm run verify:ui
npm audit
```

verify는 타입·테스트·빌드·캐릭터 팩 검증·팩 모의 실행·공개 파일 검사를 실행합니다. verify:ui는 빌드된 웹의 전체 화면 검사를 실행합니다. 실제 모델을 호출하지 않습니다. 브라우저 설치 조건과 개별 검사는 [개발 안내](development.md)와 [스크립트 목록](../scripts/README.md)에 있습니다.

CI는 Windows·Linux의 Node 24에서 verify를, Linux에서 UI·카탈로그 검사를 수행합니다. 실제 Codex·API smoke는 CI에 포함하지 않으므로 API 키나 Codex 로그인 파일을 Secrets에 등록할 필요가 없습니다.

## 포함할 파일과 제외할 파일

| 포함 | 용도 |
|---|---|
| src/, tests/, scripts/, docs/, examples/ | 소스·검증·사용 안내·예제 설정 |
| assets/npc-canon/ | 6개 세계관·36명 원본·평가 사례·이미지·카탈로그 |
| package.json, package-lock.json, TS/Vite 설정, .github/, .gitignore | 재현 가능한 개발 구성 |
| README.md, SECURITY.md | 시작 안내·데이터 경계 |

캐릭터 팩에는 NPC별 비공개 설정도 들어 있습니다. 작성자 자료라는 점을 알고 공개하세요. 이미지 생성 프롬프트·수정 이력은 [art-production.json](../assets/npc-canon/art-production.json)에 있습니다.

`.gitignore`는 실행 데이터 data/, 결과 reports/, exports/, outputs/, .cache/, node_modules/, dist/, DB·압축 파일·로그인·환경 파일을 제외합니다. 제외된 로컬 결과는 삭제하지 않습니다. 공개 데이터셋이 필요하면 원문·비공개 설정·개인 경로·계정 관련 정보를 검토한 사본을 별도로 만드세요.

`npm run check:publish`는 이미 추적된 파일도 검사하고 `.cache/publication-manifest.json`에 파일·SHA256을 남깁니다. 과거 커밋의 비밀, 압축 내부, 이미지 메타데이터는 검사하지 않습니다. 자세한 경계는 [SECURITY.md](../SECURITY.md)에 있습니다.

## 커밋과 업로드

이미 Git 저장소라면 다시 초기화하지 않습니다. 현재 브랜치·원격·변경 내용을 먼저 확인하세요.

```powershell
git status --short
git remote -v
git diff --stat
```

아직 저장소가 없는 새 복사본만 `git init -b main`으로 초기화합니다. 실제로 포함할 파일을 검토한 후 스테이징하고 공개 검사를 실행합니다.

```powershell
git add .
git diff --cached --stat
git diff --cached
npm run check:publish
git commit -m "Update NPC Dialogue Lab"
```

원격이 없는 경우에만 GitHub에서 만든 실제 주소로 `git remote add origin https://github.com/OWNER/REPOSITORY.git`을 사용합니다. 이미 있는 origin을 임의로 덮어쓰지 않습니다. 검토한 현재 브랜치를 `git push -u origin <현재-브랜치>`로 업로드합니다. 공개 범위와 라이선스는 저장소 소유자가 정합니다.

현재 라이선스 파일은 미지정입니다. 공개 라이선스로 배포하려면 코드·시나리오·이미지의 사용 조건을 선택해 LICENSE에 명시하세요. 이번 문서 갱신은 라이선스를 임의 선택하거나 기록을 공개하지 않습니다.
