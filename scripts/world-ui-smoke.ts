import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { serve } from '../src/server/main.js';
import type { MockAdapter } from '../src/adapters/mock.js';
import type { RunDetail, RunListItem } from '../src/shared/types.js';

const server = await serve({ port: 4326, mock: true, data: `.cache/history-ui-world-${Date.now()}`, history: false });
const adapter = server.engine.adapter as MockAdapter; adapter.delayMs = 1;
const turn = adapter.turn.bind(adapter);
adapter.turn = async (...args) => {
  const result = await turn(...args); const input = JSON.parse(args[0].input);
  if (input.task === 'environment' && input.state?.processedSpeechCount === 0) {
    result.output = JSON.stringify({ elapsedSeconds: 2, facts: [{ id: 'door', text: '입구의 문이 열려 있다.', scope: 'environment', npcId: null }], forgetFactIds: [],
      processes: [{ id: 'reply', description: '관제실의 답장을 기다리는 중', readyAtSeconds: 60, requestNpcIds: ['miru'] }], finishProcesses: [],
      events: [{ type: 'observation', text: '입구의 문이 열렸다.', npcId: null, evidence: null, processId: null }] });
  }
  return result;
};
const browser = await chromium.launch({ headless: true, channel: process.env.NPC_BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : undefined) });
const page = await browser.newPage({ baseURL: 'http://127.0.0.1:4326', viewport: { width: 1440, height: 1000 } });
const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
try {
  await page.goto('http://127.0.0.1:4326');
  await page.getByRole('button', { name: '새 실험', exact: true }).click();
  await page.getByRole('button', { name: '03 실험 조건' }).click();
  await page.getByLabel('차례에 모아 전달 환경 방식', { exact: true }).selectOption('ai');
  await page.getByLabel('매 발화마다 전달 환경 방식', { exact: true }).selectOption('ai');
  await page.getByLabel('세계 엔진 추론 강도', { exact: true }).selectOption('medium');
  await page.getByLabel('세계 엔진 추가 규칙', { exact: true }).fill('메시지 답장은 장면의 가상 시간에 맞춰 늦게 도착할 수 있다.');
  await page.getByLabel('묶음당 공개 발화 수').fill('4');
  await page.getByLabel('주기 평가와 종료 평가 사용').uncheck();
  await page.getByRole('button', { name: '실험 시작', exact: true }).click();
  await page.getByRole('dialog', { name: '실험 구성' }).waitFor({ state: 'hidden' });
  await page.waitForFunction(async () => { const runs = await fetch('/api/runs').then(r => r.json()); return runs.length === 2 && runs.every((r: any) => r.status === 'completed'); });
  const runs = await (await page.request.get('/api/runs')).json() as RunListItem[];
  for (const run of runs) {
    const detail = await (await page.request.get(`/api/runs/${run.id}`)).json() as RunDetail;
    assert.equal(detail.summary.byKind.environment.calls, 4); assert.equal(detail.run.spec.worldEngine?.effort, 'medium');
    assert.ok(detail.run.worldState?.virtualSeconds); assert.equal(detail.run.worldState?.processes[0].status, 'pending');
  }
  await page.locator('.run-card').first().click();
  await page.getByRole('button', { name: '세계 상태', exact: true }).click();
  await page.getByRole('heading', { name: /세계 상태 · 시작 후/ }).waitFor();
  await page.locator('.world-state').getByText('관제실의 답장을 기다리는 중', { exact: true }).waitFor();
  await page.locator('.world-state').getByText('입구의 문이 열려 있다.', { exact: false }).waitFor();
  await page.getByRole('button', { name: '호출·계측', exact: true }).click();
  await page.getByLabel('호출 종류 필터').selectOption('environment');
  // API completion can precede the detail refresh delivered to the browser.
  await page.locator('tr.clickable').nth(3).waitFor({ state: 'visible' });
  assert.equal(await page.locator('tr.clickable').count(), 4);
  await page.locator('tr.clickable').first().click();
  await page.getByRole('heading', { name: '입력', exact: true }).waitFor();
  await page.getByRole('button', { name: '실행 설정', exact: true }).click();
  await page.locator('.run-settings').getByText('AI 세계 엔진', { exact: true }).waitFor();
  await page.getByRole('button', { name: '대화 기록', exact: true }).click();
  assert.equal(await page.locator('.narrator').filter({ hasText: '세계 엔진' }).count(), 1);
  assert.equal(await page.locator('.message').count(), 4);
  const waiting = page.waitForEvent('download'); await page.getByRole('button', { name: '데이터 ZIP 다운로드' }).click();
  const download = await waiting; const path = await download.path();
  assert.ok((await readFile(path!)).includes(Buffer.from('world-state.json')));
  await page.getByRole('button', { name: '세계 상태', exact: true }).click();
  await mkdir('.cache/screenshots', { recursive: true });
  await page.screenshot({ path: '.cache/screenshots/world-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await page.screenshot({ path: '.cache/screenshots/world-mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS world engine editor, two delivery modes, world state, call filter, snapshot, transcript, export, mobile');
} finally { await browser.close(); await server.close(); }
