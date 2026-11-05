import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { serve } from '../src/server/main.js';
import type { MockAdapter } from '../src/adapters/mock.js';
import type { RunDetail, RunListItem } from '../src/shared/types.js';

const server = await serve({ port: 4327, mock: true, data: `.cache/history-ui-spatial-${Date.now()}`, history: false });
const adapter = server.engine.adapter as MockAdapter; adapter.delayMs = 1;
const turn = adapter.turn.bind(adapter), spoken = new Set<string>();
adapter.turn = async (...args) => {
  const result = await turn(...args), input = JSON.parse(args[0].input);
  if (result.status !== 'completed') return result;
  if (input.task === 'event_generation') result.output = JSON.stringify({ proposal: { title: '휴게실 징후', description: '휴게실 조명이 잠깐 깜박인다.', locationIds: ['lounge'], severity: 'low' } });
  if (input.task === 'speak' && !spoken.has(args[0].threadId)) {
    spoken.add(args[0].threadId);
    if (adapter.instructions.get(args[0].threadId)!.includes('당신은 윤입니다')) result.output = JSON.stringify({ speech: '둘만 아는 귓속말입니다.', action: '미루 쪽으로 몸을 기울인다.', communication: { mode: 'whisper', targetNpcIds: ['miru'], channelId: null }, moveToLocationId: null, activityChoice: 'start' });
  }
  return result;
};
const browser = await chromium.launch({ headless: true, channel: process.env.NPC_BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : undefined) });
const page = await browser.newPage({ baseURL: 'http://127.0.0.1:4327', viewport: { width: 1440, height: 1000 } });
const errors: string[] = []; page.on('pageerror', e => errors.push(e.message)); page.on('dialog', dialog => void dialog.accept());
try {
  await page.goto('http://127.0.0.1:4327'); await page.getByRole('button', { name: '새 실험', exact: true }).click();
  await page.getByRole('button', { name: '분산 공간 예제 불러오기', exact: true }).click();
  await page.getByLabel('윤 시작 위치', { exact: true }).selectOption('lounge');
  await page.getByLabel('세린 시작 위치', { exact: true }).selectOption('workshop');
  await page.getByLabel('장소 1 이름', { exact: true }).fill('설비 작업실');
  await page.getByRole('button', { name: '03 실험 조건' }).click();
  await page.getByLabel('분산 공간 · 상황 발생 켬 전달 방식', { exact: true }).selectOption('per_utterance');
  assert.equal(await page.getByLabel('분산 공간 · 상황 발생 끔 환경 방식', { exact: true }).inputValue(), 'ai_spatial');
  await page.getByLabel('검토 간격 (가상 초)', { exact: true }).fill('1'); await page.getByLabel('최대 제안 수', { exact: true }).fill('1');
  await page.getByLabel('묶음당 공개 발화 수').fill('12'); await page.getByLabel('주기 평가와 종료 평가 사용').uncheck();
  await page.getByRole('button', { name: '실험 시작', exact: true }).click();
  await page.getByRole('dialog', { name: '실험 구성' }).waitFor({ state: 'hidden' });
  await server.engine.idle();
  await page.waitForFunction(async () => { const runs = await fetch('/api/runs').then(r => r.json()); return runs.length === 2 && runs.every((r: any) => ['completed', 'paused'].includes(r.status)); });
  const runs = await (await page.request.get('/api/runs')).json() as RunListItem[];
  for (const run of runs) {
    const d = await (await page.request.get(`/api/runs/${run.id}`)).json() as RunDetail;
    assert.equal(d.run.status, 'completed', d.run.error ?? ''); assert.equal(d.summary.speechCount, 12);
    assert.equal(d.summary.byKind.event_generation.calls, d.run.variant.eventGeneration ? 1 : 0);
  }
  await page.locator('.run-card').filter({ hasText: '상황 발생 켬' }).click();
  await page.getByRole('button', { name: '대화 기록', exact: true }).click();
  assert.ok(await page.locator('.transcript').getByText('둘만 아는 귓속말입니다.', { exact: true }).count());
  await page.getByLabel('관찰 관점').selectOption('doha');
  assert.equal(await page.locator('.transcript').getByText('둘만 아는 귓속말입니다.', { exact: true }).count(), 0);
  assert.ok(await page.locator('.transcript').getByText('미루 쪽으로 몸을 기울인다.', { exact: true }).count());
  await page.getByLabel('관찰 관점').selectOption('miru');
  assert.ok(await page.locator('.transcript').getByText('둘만 아는 귓속말입니다.', { exact: true }).count());
  await page.getByLabel('관찰 관점').selectOption('serin');
  assert.equal(await page.locator('.transcript').getByText('휴게실 조명이 잠깐 깜박인다.', { exact: false }).count(), 0);
  await page.getByLabel('관찰 관점').selectOption(''); await page.getByLabel('발생 장소').selectOption('workshop');
  assert.equal(await page.locator('.transcript').getByText('둘만 아는 귓속말입니다.', { exact: true }).count(), 0);
  await page.getByRole('button', { name: '세계 상태', exact: true }).click();
  await page.getByRole('heading', { name: '현재 위치와 진행 중 행동', exact: true }).waitFor();
  await page.locator('.spatial-places').getByText('설비 작업실', { exact: true }).waitFor();
  await page.getByRole('heading', { name: '상황 발생 · 관리자 기록', exact: true }).waitFor();
  await page.getByRole('button', { name: '호출·계측', exact: true }).click(); await page.getByLabel('호출 종류 필터').selectOption('event_generation');
  assert.equal(await page.locator('tr.clickable').count(), 1);
  await page.getByRole('button', { name: '실행 설정', exact: true }).click(); await page.getByRole('heading', { name: '장소·연결 통로·시작 위치·통신 채널', exact: true }).waitFor();
  const downloadPromise = page.waitForEvent('download'); await page.getByRole('button', { name: '데이터 ZIP 다운로드' }).click();
  const bytes = await readFile((await (await downloadPromise).path())!); assert.ok(bytes.includes(Buffer.from('invocation-links.csv'))); assert.ok(bytes.includes(Buffer.from('situations.json')));
  await page.getByRole('button', { name: '세계 상태', exact: true }).click();
  await mkdir('.cache/screenshots', { recursive: true }); await page.screenshot({ path: '.cache/screenshots/spatial-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await page.screenshot({ path: '.cache/screenshots/spatial-mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS spatial example editor, positions, two delivery modes, private observation, world state, generator, metrics, snapshot, exports and mobile');
} catch (error) { await mkdir('.cache/screenshots', { recursive: true }); await page.screenshot({ path: '.cache/screenshots/spatial-error.png', fullPage: true }); throw error; } finally { await browser.close(); await server.close(); }
