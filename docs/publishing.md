# GitHub 업로드 준비

프로젝트 루트에서 실행합니다. 소스 저장소는 아직 초기화하지 않아도 검사할 수 있습니다. 검사에는 Git과 Node.js 24 이상이 필요합니다.

```powershell
npm ci
npm run verify
npm run smoke:ui
npm run assets:gallery
npm audit
```

`verify`는 타입 검사, 단위·통합 테스트, 서버·웹 빌드, 에셋 스키마·이미지 해시 검사, 여섯 세계관의 모의 실행, 업로드 파일 검사를 수행합니다. Codex 로그인이나 유료 모델 호출을 사용하지 않습니다. 브라우저 검사는 Windows에서 Edge를 사용합니다. 다른 OS에서는 `npx playwright install chromium`을 먼저 실행합니다.

## 포함할 파일

- `src/`, `tests/`, `scripts/`, `docs/`, `examples/`: 앱, 검증 도구, 문서와 기본 설정.
- `assets/npc-canon/`: 여섯 세계관·36명 캐릭터, 작성 원본, 평가 사례, 이미지와 오프라인 카탈로그. 캐릭터의 비공개 설정은 게임 내 정보 경계이며 이 에셋 팩 파일에는 포함됩니다.
- `package.json`, `package-lock.json`, TypeScript/Vite 설정, `.github/`, `.gitignore` 등 개발 설정.

## 로컬에 보관할 파일

`.gitignore`는 실행 데이터 `data/`, 실험 결과 `reports/`, 내보내기 `exports/`, 임시 출력 `.cache/`, 의존성 `node_modules/`, 빌드 `dist/`, SQLite와 압축 파일, 로그인·환경변수 파일을 제외합니다. 기존 실험 결과는 로컬에 보관하며 삭제하지 않습니다. 데이터셋을 공개하려면 별도 위치에서 원문·경로·계정 관련 정보와 비공개 설정을 검토한 사본을 만드세요.

검사 결과와 파일별 SHA256은 `.cache/publication-manifest.json`에서 확인합니다. 저장소가 이미 있으면 현재 추적 중인 파일도 검사하므로 `.gitignore`를 나중에 추가한 경우의 잔여 파일을 찾을 수 있습니다. 이 검사는 현재 작업 파일을 대상으로 하며 과거 커밋 이력의 비밀정보를 검사하지 않습니다.

라이선스는 현재 미지정입니다. 공개 라이선스로 배포하려면 소유자가 코드·시나리오·이미지의 사용 조건을 선택하고 `LICENSE`에 명시하세요. 이미지의 AI 생성 도구·프롬프트·수정 이력은 `assets/npc-canon/art-production.json`에 기록되어 있습니다.

## 최초 업로드

GitHub에서 저장소를 만든 뒤 실제 주소를 아래 예시의 원격 주소에 대입합니다. 공개 범위와 라이선스는 저장소 소유자가 결정합니다.

```powershell
git init -b main
git add .
git diff --cached --stat
npm run check:publish
git commit -m "Initial NPC Dialogue Lab"
git remote add origin https://github.com/OWNER/REPOSITORY.git
git push -u origin main
```

첫 푸시 후 GitHub Actions가 Windows와 Linux의 Node.js 24에서 검증합니다. CI에서는 모의 어댑터만 사용하므로 Codex 인증정보를 Secrets에 등록할 필요가 없습니다.
