import { chromium, type Route } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { serve } from '../src/server/main.js';
import type { ExperimentSpec } from '../src/shared/schema.js';
import type { Run, RunDetail } from '../src/shared/types.js';
const server = process.env.NPC_UI_URL ? null : await serve({ port: 4319, mock: true, data: `.cache/history-ui-dashboard-${Date.now()}`, history: false });
const base = process.env.NPC_UI_URL ?? 'http://127.0.0.1:4319';
const channel = process.env.NPC_BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : undefined);
const browser = await chromium.launch({ headless: true, channel, executablePath: process.env.NPC_BROWSER_EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 1440, height: 1080 }, deviceScaleFactor: 1 });
const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
try {
  await page.goto(base); await page.getByRole('button', { name: '새 실험', exact: true }).waitFor();
  await page.getByRole('button', { name: '새 실험', exact: true }).click();
  await page.getByLabel('환경 진행 규칙 사용').waitFor();
  assert.equal(await page.getByLabel('모든 목표 달성 시 종료').isChecked(), true);
  await page.getByRole('button', { name: '03 실험 조건' }).click();
  await page.getByLabel('묶음당 공개 발화 수').fill('6');
  await page.getByLabel('평가 간격 (발화)').fill('3');
  await page.getByRole('button', { name: '실험 시작', exact: true }).click();
  await page.getByRole('dialog', { name: '실험 구성' }).waitFor({ state: 'hidden' });
  await page.waitForFunction(async () => { const runs = await fetch('/api/runs').then(r => r.json()); return runs.length >= 2 && runs.slice(0, 2).every((r: any) => r.status === 'completed'); }, { timeout: 30_000 });
  await page.waitForFunction(() => !document.querySelector('.run-card .badge.running'));
  await page.getByRole('button', { name: '매 발화마다 전달', exact: false }).first().click();
  await page.getByRole('button', { name: '호출·계측', exact: true }).click();
  await page.getByLabel('호출 종류 필터').selectOption('receive');
  assert.equal(await page.locator('tr.clickable').count(), 27); // 6 speeches * 2 + 5 environment outcomes * 3
  await page.locator('tr.clickable').first().click(); await page.getByRole('heading', { name: '입력', exact: true }).waitFor();
  await page.getByRole('button', { name: '대화 기록', exact: true }).click();
  await mkdir('.cache/screenshots', { recursive: true });
  await page.screenshot({ path: '.cache/screenshots/desktop.png', fullPage: true });
  await page.getByRole('button', { name: '비교 분석', exact: false }).first().click();
  await page.getByRole('heading', { name: '같은 발화 순번에서 비교' }).waitFor();
  await page.getByRole('heading', { name: '모델·추론별 집계' }).waitFor();
  await page.locator('.comparison').getByText('어휘 반복률', { exact: true }).waitFor();
  await page.locator('.comparison').getByText('목표 달성', { exact: true }).waitFor();
  await page.screenshot({ path: '.cache/screenshots/compare.png', fullPage: true });
  await page.getByRole('button', { name: '데이터 내보내기', exact: false }).first().click();
  const downloadPromise = page.waitForEvent('download'); await page.getByRole('link', { name: 'ZIP' }).first().click();
  const download = await downloadPromise; assert.ok(download.suggestedFilename().endsWith('.zip'));
  await download.saveAs('.cache/screenshots/export.zip');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '대화 실험실', exact: false }).first().click();
  await page.screenshot({ path: '.cache/screenshots/mobile.png', fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1); assert.equal(overflow, false);

  // A successful mutation must release the UI even if background refreshes never
  // finish or fail. Gate GETs explicitly; the injection POST remains real and local.
  if (server) {
    await page.setViewportSize({ width: 1440, height: 1080 });
    const pausedSpec = await (await page.request.get(`${base}/api/example`)).json() as ExperimentSpec;
    pausedSpec.name = '상황 투입 후 화면 갱신 회귀 검사';
    pausedSpec.variants = [{ ...pausedSpec.variants[0], deliveryMode: 'batched_on_turn' }];
    pausedSpec.evaluation.enabled = false;
    delete pausedSpec.scenario.environment;
    const created = await page.request.post(`${base}/api/experiments`, { data: { spec: pausedSpec, start: false } });
    assert.equal(created.status(), 200);
    const { runs: [paused] } = await created.json() as { runs: Run[] };
    await page.locator('.run-card').filter({ hasText: pausedSpec.name }).click();
    const eventInput = page.getByLabel('새 상황', { exact: true });
    const eventText = '화면 갱신이 지연되거나 실패해도 한 번만 저장되는 상황.';
    await eventInput.fill(eventText);
    const detailPath = `/api/runs/${paused.id}`, injectPath = `${detailPath}/inject`;
    const matchesRead = (url: URL) => url.pathname === '/api/runs' || url.pathname === detailPath;
    let releaseReads!: () => void;
    const readGate = new Promise<void>(resolve => { releaseReads = resolve; });
    const refreshError = '회귀 검사: 화면 갱신 GET 실패';
    const delayReads = async (route: Route) => {
      if (route.request().method() !== 'GET') { await route.continue(); return; }
      await readGate;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: refreshError }) });
    };
    await page.route(matchesRead, delayReads);
    let injectionRequests = 0;
    const countInjection = (request: import('playwright').Request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === injectPath) injectionRequests++;
    };
    page.on('request', countInjection);
    try {
      const readStarted = page.waitForRequest(request => request.method() === 'GET' && matchesRead(new URL(request.url())));
      const injected = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === injectPath);
      await page.getByRole('button', { name: '투입', exact: true }).click();
      assert.equal((await injected).status(), 200);
      await readStarted;
      await page.waitForFunction(() => {
        const input = document.querySelector<HTMLInputElement>('input[aria-label="새 상황"]');
        const resume = Array.from(document.querySelectorAll<HTMLButtonElement>('.controls button')).find(button => button.textContent?.trim() === '재개');
        return input?.value === '' && resume && !resume.disabled;
      });
      assert.equal(await page.getByRole('button', { name: '한 발화 진행', exact: true }).isDisabled(), false);

      releaseReads();
      await page.locator('.content > .alert.error').filter({ hasText: refreshError }).waitFor();
      assert.equal(await eventInput.inputValue(), '');
      assert.equal(await page.getByRole('button', { name: '재개', exact: true }).isDisabled(), false);
      const stored = await page.request.get(`${base}${detailPath}`); // APIRequestContext bypasses page routes.
      assert.equal(stored.status(), 200);
      const saved = await stored.json() as RunDetail;
      assert.equal(saved.utterances.filter(utterance => utterance.kind === 'event' && utterance.speech === eventText).length, 1);
      assert.equal(injectionRequests, 1);
    } finally {
      releaseReads();
      await page.unrouteAll({ behavior: 'wait' });
      page.off('request', countInjection);
    }
  }
  assert.deepEqual(errors, []); console.log(`UI_SMOKE_OK: editor, two modes, invocation filter, comparison, ZIP download, mobile, ${server ? 'mutation success despite delayed/failed refresh, ' : ''}no runtime errors`);
} finally { await browser.close(); await server?.close(); }
