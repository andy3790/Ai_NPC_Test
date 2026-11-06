import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { serve } from '../src/server/main.js';
import { spatialExample } from '../src/shared/spatial-example.js';
import { getModelCatalog, installModelCatalog } from '../src/shared/model-catalog.js';
import type { MockAdapter } from '../src/adapters/mock.js';

await mkdir('.cache', { recursive: true });
const root = await mkdtemp(resolve('.cache/model-pricing-ui-'));
const original = getModelCatalog(), edited = getModelCatalog();
edited.models.find(m => m.id === 'gpt-6.1-terra')!.pricing!.input = 1.2;
edited.models.push({ id: 'fixture-new-model', enabled: true, api: { efforts: ['low'], defaultEffort: 'low', reasoning: true },
  pricing: { input: .33, cached: .03, output: 1.7 } });
edited.models.push({ id: 'fixture-unpriced-model', enabled: true, api: { efforts: ['low'], defaultEffort: 'low', reasoning: true }, pricing: null });
installModelCatalog(edited);
const server = await serve({ port: 0, data: root, mock: true, history: false });
server.engine.adapter.models = async () => getModelCatalog().models.flatMap(m => m.enabled && m.api ? [{ id: m.id, name: m.name ?? m.id, ...m.api }] : []);
const spec = spatialExample('gpt-6-luna'); spec.variants = [spec.variants[1]];
server.engine.store.setting('lastSpec', spec);
const browser = await chromium.launch(process.platform === 'win32' ? { channel: 'msedge', headless: true } : { headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } }); const errors: string[] = [];
page.on('pageerror', error => errors.push(error.message));
const dialog = page.getByRole('dialog', { name: '실험 구성' });
const priceField = (label: string) => dialog.getByLabel(label, { exact: true }).locator('..').locator('.model-price');
try {
  await page.goto(server.app.listeningOrigin);
  await page.getByRole('button', { name: '새 실험', exact: true }).click();
  const basic = dialog.getByLabel('기본 모델', { exact: true });
  assert.equal(await basic.locator('option[value^="gpt-4.1-mini"]').count(), 0);
  assert.match(await priceField('기본 모델').innerText(), /입력 \$0\.10 · 출력 \$0\.50/);
  await basic.selectOption('fixture-new-model');
  assert.match(await priceField('기본 모델').innerText(), /입력 \$0\.33 · 출력 \$1\.70/);
  await basic.selectOption('fixture-unpriced-model');
  assert.match(await priceField('기본 모델').innerText(), /단가 미등록/);
  await basic.selectOption('fixture-new-model');
  await dialog.getByRole('button', { name: '02 캐릭터' }).click();
  assert.match(await dialog.locator('.model-inherited').innerText(), /조건 적용: fixture-new-model/);
  await dialog.getByLabel('NPC 모델 재정의', { exact: true }).selectOption('gpt-6.1-terra');
  assert.match(await priceField('NPC 모델 재정의').innerText(), /입력 \$1\.20 · 출력 \$5\.00/);
  assert.match(await priceField('NPC 모델 재정의').innerText(), /272,000토큰 초과: 입력 \$2\.00 · 출력 \$7\.50/);
  await dialog.getByRole('button', { name: '03 실험 조건' }).click();
  await dialog.getByLabel(`${spec.variants[0].label} 진행 방식`, { exact: true }).selectOption('director');
  assert.match(await dialog.locator('.matrix').innerText(), /fixture-new-model[\s\S]*입력 \$0\.33 · 출력 \$1\.70/);
  for (const label of ['모델', '평가 모델', '진행자 모델', '세계 엔진 모델', '상황 발생 모델']) {
    const field = dialog.getByLabel(label, { exact: true });
    assert.equal(await field.locator('option[value^="gpt-4.1-mini"]').count(), 0);
    await field.selectOption('fixture-new-model');
    assert.match(await priceField(label).innerText(), /입력 \$0\.33 · 출력 \$1\.70/);
  }
  await mkdir('.cache/screenshots', { recursive: true });
  await dialog.locator('.matrix').scrollIntoViewIfNeeded();
  await page.screenshot({ path: '.cache/screenshots/model-pricing-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.getByLabel('모델', { exact: true }).scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  assert.equal(await dialog.locator('.editor-body').evaluate(element => element.scrollWidth > element.clientWidth + 1), false);
  await page.screenshot({ path: '.cache/screenshots/model-pricing-mobile.png', fullPage: true });
  await dialog.getByRole('button', { name: '저장', exact: true }).click();
  await page.waitForFunction(async () => (await fetch('/api/config').then(r => r.json())).scenario.defaults.model === 'fixture-new-model');
  const saved = server.engine.store.setting('lastSpec') as typeof spec;
  assert.equal(saved.scenario.characters[0].model, 'gpt-6.1-terra');
  for (const model of [saved.variants[0].model, saved.evaluation.model, saved.director.model, saved.worldEngine?.model, saved.eventGenerator?.model]) assert.equal(model, 'fixture-new-model');
  assert.equal((server.engine.adapter as MockAdapter).requests.length, 0); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, runtimeCatalogOverridesBundledPrices: true, allModelSelectors: true, mobile: true, modelCalls: 0 }));
} finally { await browser.close(); await server.close(); installModelCatalog(original); }
