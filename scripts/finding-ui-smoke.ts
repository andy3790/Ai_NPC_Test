// Delayed PATCH requests exercise both completion orders without paid model calls.
import { chromium, type Route } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { serve } from '../src/server/main.js';
import { historyFixture } from '../tests/history-fixture.js';

mkdirSync('.cache', { recursive: true });
const root = mkdtempSync(resolve('.cache/history-ui-findings-'));
const fixture = await historyFixture(join(root, 'npc-lab.sqlite'), 'mock');
const finding = fixture.detail.findings[0];
const server = await serve({ port: 0, mock: true, data: root, history: false });
const browser = await chromium.launch({ headless: true, channel: process.env.NPC_BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : undefined), executablePath: process.env.NPC_BROWSER_EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
const path = `/api/findings/${finding.id}`;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function waitForPatch(event: ReturnType<typeof deferred>) {
  let timer!: ReturnType<typeof setTimeout>;
  try { await Promise.race([event.promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('검토 PATCH 요청이 전송되지 않았습니다.')), 10_000); })]); }
  finally { clearTimeout(timer); }
}

try {
  for (const first of ['review', 'note'] as const) {
    server.engine.review(finding.id, { review: 'unreviewed', note: '' });
    await page.goto(server.app.listeningOrigin);
    await page.getByRole('button', { name: '평가 결과', exact: false }).click();
    const note = page.getByLabel('검토 메모', { exact: true });
    const review = page.getByLabel('평가 검토 상태', { exact: true });
    const gates = { note: deferred(), review: deferred() };
    const received = { note: deferred(), review: deferred() };
    const patches: Record<string, unknown>[] = [];
    const handler = async (route: Route) => {
      if (route.request().method() !== 'PATCH') { await route.continue(); return; }
      const body = route.request().postDataJSON() as Record<string, unknown>;
      patches.push(body);
      const field = Object.hasOwn(body, 'note') ? 'note' : 'review';
      received[field].resolve();
      await gates[field].promise;
      await route.continue();
    };
    await page.route(`**${path}`, handler);
    try {
      const memo = `${first} 먼저 완료되어도 보존되는 메모`;
      await note.fill(memo);
      await note.press('Tab');
      await waitForPatch(received.note);
      await review.selectOption('confirmed');
      await waitForPatch(received.review);
      assert.deepEqual(patches, [{ note: memo }, { review: 'confirmed' }]);

      const second = first === 'note' ? 'review' : 'note';
      for (const field of [first, second] as const) {
        const response = page.waitForResponse(value => value.url().endsWith(path) && value.request().method() === 'PATCH' && Object.hasOwn(value.request().postDataJSON(), field));
        gates[field].resolve();
        assert.equal((await response).status(), 200);
      }
      assert.equal(server.engine.store.get('findings', finding.id)?.review, 'confirmed');
      assert.equal(server.engine.store.get('findings', finding.id)?.note, memo);
      await page.reload();
      await page.getByRole('button', { name: '평가 결과', exact: false }).click();
      assert.equal(await review.inputValue(), 'confirmed');
      assert.equal(await note.inputValue(), memo);
    } finally {
      gates.note.resolve(); gates.review.resolve();
      await page.unroute(`**${path}`, handler);
    }
  }
  assert.deepEqual(errors, []);
  console.log('FINDING_UI_OK: note and review edits survive both PATCH completion orders');
} finally { await browser.close(); await server.close(); }
