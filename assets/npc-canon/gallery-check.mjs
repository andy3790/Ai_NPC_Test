import { chromium } from 'playwright';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root=path.dirname(fileURLToPath(import.meta.url));
const out=path.resolve(root,'../../.cache/npc-canon-qa');await mkdir(out,{recursive:true});
const catalog=JSON.parse(await readFile(path.join(root,'catalog.json'),'utf8'));
const launch={headless:true,channel:process.env.NPC_BROWSER_CHANNEL??(process.platform==='win32'?'msedge':undefined),executablePath:process.env.NPC_BROWSER_EXECUTABLE};
const browser=await chromium.launch(launch);const page=await browser.newPage({viewport:{width:1440,height:1050},deviceScaleFactor:1});
const errors=[];page.on('pageerror',e=>errors.push(e.message));const external=[];page.on('request',r=>{if(/^https?:/.test(r.url()))external.push(r.url());});
const checkOverflow=async()=>assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'페이지 가로 넘침');
try {
  await page.goto(pathToFileURL(path.join(root,'index.html')).href);await page.locator('.card').first().waitFor();
  assert.equal(await page.locator('.card').count(),6);await checkOverflow();
  const reviewed=[];
  for(const w of catalog.worlds) {
    await page.locator(`[data-world="${w.id}"]`).click();assert.equal(await page.locator('.card').count(),6);
    await page.locator('.hero img').evaluate(img=>img.decode());
    assert.equal(await page.locator('.hero h2').textContent(),w.name);
    const links=await page.locator('a[href]').evaluateAll(xs=>xs.map(x=>x.getAttribute('href')));
    for(const link of links)await access(path.resolve(root,link));
    reviewed.push(w.id);
  }
  await page.locator('[data-world="tidemark"]').click();
  await page.screenshot({path:path.join(out,'catalog-desktop.png'),fullPage:true});
  await page.locator('[data-character="tid-seoyul"]').click();
  assert.equal(await page.locator('#dialog').getAttribute('open'),'');assert.equal(await page.locator('.profile section').count(),2);
  assert.equal(await page.locator('#modal-content').getByText('날짜 확인').count(),0);
  await page.keyboard.press('Escape');await page.locator('#private').check();
  for(const w of catalog.worlds) {
    await page.locator(`[data-world="${w.id}"]`).click();
    for(const c of w.characters) {
      await page.locator(`[data-character="${c.id}"]`).click();assert.equal(await page.locator('#char-name').textContent(),c.name);
      assert.equal(await page.locator('.profile section').count(),14);
      assert.ok((await page.locator('#modal-content').innerText()).includes('[본인만 아는 확정 기억]'));
      await page.keyboard.press('Escape');
    }
  }
  await page.locator('#search').fill('L4');assert.equal(await page.locator('.card').count(),1);
  await page.locator('[data-character="orb-l4"]').click();await page.screenshot({path:path.join(out,'character-private.png')});await page.keyboard.press('Escape');
  await page.locator('#search').fill('존재하지않는이름');assert.equal(await page.locator('.empty').count(),1);
  await page.locator('#search').fill('');await page.locator('[data-world="orchard"]').click();await page.locator('#private').uncheck();
  await page.setViewportSize({width:390,height:844});await checkOverflow();
  await page.screenshot({path:path.join(out,'catalog-mobile.png'),fullPage:true});
  await page.locator('[data-character="orc-gyeongja"]').click();await checkOverflow();await page.keyboard.press('Escape');
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  const report={status:'passed',checkedAt:new Date().toISOString(),worlds:reviewed,characterDialogs:36,checks:['6개 세계관 전환·배경 로드','36개 캐릭터 상세 및 비공개 토글','전체 세계관 검색·빈 결과','다운로드·문서 링크 파일 존재','1440px 데스크톱과 390px 모바일 가로 넘침 없음','키보드 Escape로 상세 닫기','브라우저 JavaScript 오류 없음','외부 네트워크 요청 없음'],screenshots:['catalog-desktop.png','character-private.png','catalog-mobile.png'].map(x=>path.posix.join('.cache/npc-canon-qa',x)),note:'스크린샷은 .cache/npc-canon-qa에 저장. PNG 원본은 수정하지 않음.'};
  await writeFile(path.join(out,'gallery-report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{await browser.close();}
