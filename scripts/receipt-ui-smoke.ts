import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { serve } from '../src/server/main.js';
import { exampleSpec } from '../src/shared/example.js';

const server = await serve({port:0,mock:true,data:'.cache/history-ui-receipts-'+Date.now(),history:false});
const spec=exampleSpec('mock-model'); spec.maxUtterances=1; spec.evaluation.enabled=false; spec.variants=[spec.variants[1]];
await server.engine.create(spec); await server.engine.idle();
const browser=await chromium.launch({headless:true,channel:process.platform==='win32'?'msedge':undefined});
const page=await browser.newPage({viewport:{width:1440,height:1080}});
const errors:string[]=[]; page.on('pageerror',e=>errors.push(e.message));
try {
  await page.goto(server.app.listeningOrigin);
  await page.getByRole('button',{name:'수신 상태',exact:true}).click();
  await page.getByText('수신 기록 5개 · 수신 전용 호출 3회.',{exact:false}).waitFor();
  assert.equal(await page.locator('tbody tr').count(),5);
  assert.equal(await page.getByText('윤 발화 #1',{exact:true}).count(),2);
  assert.equal(await page.getByText('발화 #1 환경 결과',{exact:true}).count(),3);
  assert.equal(await page.getByText('함께 수신 (#1 · #2)',{exact:true}).count(),4);
  await page.screenshot({path:'.cache/receipt-audit-ui.png',fullPage:true});
  await page.getByRole('button',{name:'호출·계측',exact:true}).click();
  await page.getByLabel('호출 종류 필터').selectOption('receive');
  assert.equal(await page.locator('tbody tr.clickable').count(),3);
  assert.equal(await page.getByText('관찰 2건 함께 수신',{exact:true}).count(),2);
  await page.locator('tbody tr.clickable').first().click();
  const input=JSON.parse(await page.locator('.call-detail pre').first().textContent() ?? '{}');
  assert.equal(input.messages.length,2); assert.equal(input.messages[0].kind,'speech'); assert.equal(input.messages[1].kind,'event');
  await page.getByRole('button',{name:'수신 상태',exact:true}).click();
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({status:'passed',receiptRows:5,receiveCalls:3,bundledCalls:2,pageErrors:errors,mobileOverflow:false}));
} finally {await browser.close();await server.close();}
