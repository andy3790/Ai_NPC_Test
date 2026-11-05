import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { serve } from '../src/server/main.js';
const root = `.cache/history-ui-editor-${Date.now()}`;
const server = await serve({ port: 0, mock: true, data: root, history: false });
const browser = await chromium.launch({ headless: true, channel: process.env.NPC_BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : undefined), executablePath: process.env.NPC_BROWSER_EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
const dialog = page.getByRole('dialog', { name: '실험 구성' });
const scope = (name: string) => dialog.getByRole('group', { name: 'JSON 편집 범위' }).getByRole('button', { name: new RegExp(`^${name}(?:$| ·)`) }).click();
const field = (name: string) => dialog.getByLabel(`${name} JSON`, { exact: true });
const full = async () => { await scope('전체 설정'); return JSON.parse(await field('전체 설정').inputValue()); };
try {
  await page.goto(server.app.listeningOrigin); await page.getByRole('button', { name: '새 실험', exact: true }).click();
  await dialog.getByRole('button', { name: 'JSON 편집', exact: true }).click();
  const initial = await full(); let expected = structuredClone(initial);
  // Environment drafts survive tab/dialog/detail changes and cannot be silently omitted at launch.
  await dialog.getByRole('button', { name: '01 시나리오' }).click();
  const environmentField = dialog.getByLabel('환경 규칙 JSON', { exact: true });
  const environmentSummary = dialog.locator('summary').filter({ hasText: '환경 규칙·목표 JSON 편집' });
  await environmentSummary.click();
  const environment = JSON.parse(await environmentField.inputValue());
  environment.actions[0].result += ' 환경 초안 보존 검증';
  const environmentDraft = JSON.stringify(environment);
  await environmentField.fill(environmentDraft);
  for (const name of ['설정 검증', '저장', '대기 상태로 생성', '실험 시작']) {
    assert.equal(await dialog.getByRole('button', { name, exact: true }).isDisabled(), true);
  }
  await environmentSummary.click(); await environmentSummary.click();
  assert.equal(await environmentField.inputValue(), environmentDraft);
  await dialog.getByRole('button', { name: '02 캐릭터' }).click();
  await dialog.getByRole('button', { name: '01 시나리오' }).click();
  assert.equal(await environmentField.inputValue(), environmentDraft);
  await dialog.getByRole('button', { name: '설정 닫기' }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '새 실험', exact: true }).click();
  assert.equal(await environmentField.inputValue(), environmentDraft);
  assert.equal(await dialog.getByRole('button', { name: '실험 시작', exact: true }).isDisabled(), true);
  await dialog.getByRole('button', { name: '환경 규칙 적용', exact: true }).click();
  expected.scenario.environment = environment;
  await dialog.getByRole('button', { name: 'JSON 편집', exact: true }).click();
  assert.deepEqual(await full(), expected);

  await dialog.getByRole('button', { name: '01 시나리오' }).click();
  await environmentField.fill(environmentDraft + ' ');
  await dialog.getByLabel('모든 목표 달성 시 종료').uncheck();
  expected.scenario.environment.stopOnGoals = false;
  assert.equal(await dialog.getByRole('button', { name: '환경 규칙 적용', exact: true }).isDisabled(), true);
  assert.match(await dialog.getByRole('alert').innerText(), /초안은 보존/);
  await dialog.getByRole('button', { name: '현재 환경 설정 다시 불러오기', exact: true }).click();
  assert.deepEqual(JSON.parse(await environmentField.inputValue()), expected.scenario.environment);
  await environmentField.fill('{');
  await dialog.getByRole('button', { name: '환경 규칙 적용', exact: true }).click();
  assert.equal(await dialog.getByRole('alert').count(), 1);
  assert.equal(await dialog.getByRole('button', { name: '저장', exact: true }).isDisabled(), true);
  await dialog.getByRole('button', { name: '현재 환경 설정 다시 불러오기', exact: true }).click();
  assert.equal(await dialog.getByRole('button', { name: '저장', exact: true }).isDisabled(), false);

  await dialog.getByRole('button', { name: '01 시나리오' }).click();
  await dialog.getByRole('button', { name: '세계관 JSON 편집', exact: true }).click();
  const world = JSON.parse(await field('세계관').inputValue()); assert.equal(world.characters, undefined);
  world.world += '\n세계관 JSON 수정 검증'; world.name = '부분 편집 장면';
  await field('세계관').fill(JSON.stringify(world));
  await page.waitForFunction(() => !!document.querySelector('.editor-footer .primary:disabled'));
  await dialog.getByRole('button', { name: '세계관 JSON 적용', exact: true }).click();
  Object.assign(expected.scenario, world); assert.deepEqual(await full(), expected);

  await dialog.getByRole('button', { name: '02 캐릭터' }).click();
  await dialog.locator('.character-tabs').getByRole('button', { name: '도하', exact: true }).click();
  await dialog.getByRole('button', { name: '선택 캐릭터 JSON 편집', exact: true }).click();
  const character = JSON.parse(await field('선택 캐릭터').inputValue()); assert.equal(character.id, 'doha');
  character.speechStyle = '느긋하고 친근한 반말'; character.behaviors = '고개를 기울인다.';
  await field('선택 캐릭터').fill(JSON.stringify(character));
  await dialog.getByRole('button', { name: '선택 캐릭터 JSON 적용', exact: true }).click();
  expected.scenario.characters[1] = character; assert.deepEqual(await full(), expected);
  await dialog.getByRole('button', { name: '02 캐릭터' }).click();
  assert.equal(await dialog.getByLabel('말투·어휘', { exact: true }).inputValue(), character.speechStyle);
  await dialog.getByRole('button', { name: '전체 캐릭터 JSON 편집', exact: true }).click();
  const chars = expected.scenario.characters; expected.scenario.characters = [chars[2], chars[0], chars[1]];
  await field('전체 캐릭터').fill(JSON.stringify(expected.scenario.characters));
  await dialog.getByRole('button', { name: '전체 캐릭터 JSON 적용', exact: true }).click();
  assert.deepEqual(await full(), expected);

  // JSON syntax errors and cross-section errors never overwrite the current spec.
  await scope('선택 캐릭터'); await dialog.getByLabel('JSON 편집 캐릭터').selectOption('0');
  const validCharacter = await field('선택 캐릭터').inputValue(); await field('선택 캐릭터').fill('{');
  await dialog.getByRole('button', { name: '선택 캐릭터 JSON 적용', exact: true }).click();
  assert.match(await dialog.getByRole('alert').innerText(), /기존 설정이 유지/);
  await scope('세계관'); await scope('선택 캐릭터'); assert.equal(await field('선택 캐릭터').inputValue(), '{');
  assert.equal(await dialog.getByRole('button', { name: '저장', exact: true }).isDisabled(), true);
  assert.deepEqual(await full(), expected);
  await scope('선택 캐릭터'); await field('선택 캐릭터').fill(JSON.stringify({ ...JSON.parse(validCharacter), id: 'renamed' }));
  await dialog.getByRole('button', { name: '선택 캐릭터 JSON 적용', exact: true }).click();
  assert.match(await dialog.getByRole('alert').innerText(), /알 수 없는 행동 수행자/);
  await dialog.getByRole('button', { name: '현재 설정 다시 불러오기', exact: true }).click();
  assert.equal(await field('선택 캐릭터').inputValue(), validCharacter);
  await scope('전체 캐릭터'); await field('전체 캐릭터').fill(JSON.stringify([expected.scenario.characters[0], expected.scenario.characters[0]]));
  await dialog.getByRole('button', { name: '전체 캐릭터 JSON 적용', exact: true }).click();
  assert.match(await dialog.getByRole('alert').innerText(), /중복/);
  await dialog.getByRole('button', { name: '현재 설정 다시 불러오기', exact: true }).click();
  assert.deepEqual(await full(), expected);

  await dialog.getByRole('button', { name: '03 실험 조건' }).click();
  await dialog.getByRole('button', { name: '실험 조건 JSON 편집', exact: true }).click();
  const conditions = JSON.parse(await field('실험 조건').inputValue()); assert.equal(conditions.scenario, undefined);
  conditions.variants = [conditions.variants[0]]; conditions.variants[0].label = '부분 편집 조건';
  conditions.maxUtterances = 12; conditions.repetitions = 2; conditions.evaluation.interval = 4;
  conditions.maxConcurrentCalls = 1; conditions.scheduledEvents = [{ afterUtterance: 0, text: '시작 사건' }];
  await field('실험 조건').fill(JSON.stringify(conditions));
  await dialog.getByRole('button', { name: '실험 조건 JSON 적용', exact: true }).click();
  Object.assign(expected, conditions); assert.deepEqual(await full(), expected);

  // A dirty world draft survives tab changes; changed form data requires reloading.
  await scope('세계관'); const originalWorldText = await field('세계관').inputValue();
  await field('세계관').fill(originalWorldText.replace('부분 편집 장면', '미적용 초안'));
  await dialog.getByRole('button', { name: '01 시나리오' }).click();
  expected.scenario.situation += '\n폼에서 수정'; await dialog.getByLabel('대화 시작 상황', { exact: true }).fill(expected.scenario.situation);
  await dialog.getByRole('button', { name: '세계관 JSON 편집', exact: true }).click();
  assert.match(await field('세계관').inputValue(), /미적용 초안/);
  assert.equal(await dialog.getByRole('button', { name: '세계관 JSON 적용', exact: true }).isDisabled(), true);
  assert.match(await dialog.getByRole('alert').innerText(), /초안은 보존/);
  await dialog.getByRole('button', { name: '현재 설정 다시 불러오기', exact: true }).click();
  assert.deepEqual(await full(), expected);

  // A partial JSON file only updates its selected scope.
  await scope('세계관'); const fileWorld = JSON.parse(await field('세계관').inputValue()); fileWorld.name = '세계관 파일 가져오기';
  await dialog.locator('input[type=file]').setInputFiles({ name: 'world.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fileWorld)) });
  await page.waitForFunction(() => (document.querySelector('.section-json textarea') as HTMLTextAreaElement)?.value.includes('세계관 파일 가져오기'));
  await dialog.getByRole('button', { name: '세계관 JSON 적용', exact: true }).click();
  Object.assign(expected.scenario, fileWorld); assert.deepEqual(await full(), expected);

  // Original full-file import and full JSON editing remain available.
  expected.name = '전체 JSON 기능 유지'; expected.scenario.characters[0].personality += ' 전체 JSON 수정';
  await dialog.locator('input[type=file]').setInputFiles({ name: 'full.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(expected)) });
  await page.waitForFunction(() => (document.querySelector('.section-json textarea') as HTMLTextAreaElement)?.value.includes('전체 JSON 기능 유지'));
  await dialog.getByRole('button', { name: 'JSON을 설정에 적용', exact: true }).click();
  assert.deepEqual(await full(), expected);
  await dialog.getByRole('button', { name: '저장', exact: true }).click();
  await page.waitForFunction(async () => (await fetch('/api/config').then(r => r.json()))?.name === '전체 JSON 기능 유지');
  assert.deepEqual(server.engine.store.setting('lastSpec'), expected);
  assert.equal(server.engine.store.list('runs').length, 0);
  assert.equal((server.engine.adapter as any).requests.length, 0);
  mkdirSync(`${root}/screenshots`, { recursive: true });
  await scope('전체 캐릭터'); await page.screenshot({ path: `${root}/screenshots/desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${root}/screenshots/mobile.png`, fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  assert.deepEqual(errors, []);
  console.log(`EDITOR_UI_OK: five scopes, environment draft guards, tab/dialog persistence, stale detection, isolation, validation, imports, full JSON, save, mobile, zero calls\n${root}`);
} finally { await browser.close(); await server.close(); }
