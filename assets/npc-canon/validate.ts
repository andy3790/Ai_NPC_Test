import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { experimentSchema, scenarioSchema, characterSchema, categories, evaluationSchema } from '../../src/shared/schema.js';
import { persona, evaluationPrompt } from '../../src/core/prompts.js';
import { worlds, fields, root, anchor, parts, experiment, runtimeCharacter } from './build.mjs';

const read = async (p:string)=>JSON.parse(await readFile(path.join(root,p),'utf8'));
const pack=await read('pack.json');
const schemaHash=createHash('sha256').update(await readFile(path.join(root,'../../src/shared/schema.ts'))).digest('hex');
assert.equal(pack.compatibility.schemaSha256,schemaHash,'현재 스키마가 변경되었습니다. build.mjs로 다시 생성하세요.');
const promptHash=createHash('sha256').update(await readFile(path.join(root,'../../src/core/prompts.ts'))).digest('hex');
assert.equal(pack.compatibility.promptSha256,promptHash,'현재 프롬프트가 변경되었습니다. build.mjs로 다시 생성하세요.');
assert.equal(worlds.length,6);assert.equal(pack.counts.characters,36);assert.equal(pack.experiments.length,18);
const uniqueIds=new Set<string>();const fixtureIds=new Set<string>();let characters=0,fixtures=0,privacyChecks=0;
const anchorDoc=await read('evaluation/anchors.json');const anchorIds=new Set(anchorDoc.anchors.map((a:any)=>a.id));
assert.equal(anchorIds.size,anchorDoc.anchors.length,'중복 기준 ID');
const categoryCounts:Record<string,number>={};const dispositions:Record<string,number>={};
for(const w of worlds) {
  assert.equal(w.characters.length,6);assert.ok(w.facts.length>=14);
  assert.deepEqual(w.scenarios.flatMap((s:any)=>s.cast).sort(),[0,1,2,3,4,5],'3인 묶음에 캐릭터가 빠졌습니다.');
  const worldDoc=await read(`worlds/${w.id}.world.json`);
  for(const c of w.characters) {
    assert.ok(!uniqueIds.has(c.id));uniqueIds.add(c.id);characters++;
    const saved=await read(`characters/${c.id}.character.json`);
    assert.deepEqual(characterSchema.parse(saved),saved,'캐릭터 스키마에서 무시되는 필드');
    assert.deepEqual(saved,runtimeCharacter(c));
    for(const field of fields) {assert.ok(c[field].length>=15,`${c.id}.${field}가 너무 짧습니다.`);assert.ok(saved[field].includes(anchor(c,field)));}
    assert.ok(c.memories.includes('[본인만 아는 확정 기억]'));
    const secret=c.memories.split('[본인만 아는 확정 기억]')[1].trim();
    assert.ok(!JSON.stringify(worldDoc).includes(secret),'공개 세계관에 비공개 기억 노출');
    assert.ok(c.exampleDialogue.split('\n').length>=3,`${c.id} 예시 대사 부족`);
  }
  for(const p of parts(w)) {
    const saved=await read(`experiments/${w.id}-${p.key}.json`);
    const parsed=experimentSchema.parse(saved);
    assert.deepEqual(parsed,saved,'현재 스키마가 무시하거나 기본값으로 바꾸는 필드');
    assert.deepEqual(saved,experiment(w,p));
    const sc=await read(`scenarios/${w.id}-${p.key}.scenario.json`);
    assert.deepEqual(scenarioSchema.parse(sc),sc);assert.deepEqual(sc,saved.scenario);
    assert.equal(saved.maxUtterances,60);assert.equal(saved.concurrentRuns,2);assert.equal(saved.evaluation.interval,10);
    assert.equal(saved.scenario.characters.length,p.key==='ensemble'?6:3);
    assert.deepEqual(saved.scheduledEvents.map((e:any)=>e.afterUtterance),[12,30,45]);
    const a={...saved.variants[0]},b={...saved.variants[1]};delete a.id;delete a.label;delete a.memoryMode;delete b.id;delete b.label;delete b.memoryMode;assert.deepEqual(a,b,'기억 비교에 다른 조건이 섞였습니다.');
    for(const c of saved.scenario.characters) {
      const input=persona(parsed,c);
      for(const field of fields) assert.ok(input.includes(anchor(c,field)));
      for(const other of w.characters.filter((x:any)=>x.id!==c.id)) {
        for(const field of fields) {assert.ok(!input.includes(`[${anchor(other,field)}]`));privacyChecks++;}
        const secret=other.memories.split('[본인만 아는 확정 기억]')[1].trim();assert.ok(!input.includes(secret));
      }
      for(const event of saved.scheduledEvents) assert.ok(!input.includes(event.text),'미래 사건이 초기 persona에 노출');
      assert.ok(!input.includes('requiredFindings'),'평가 정답이 persona에 노출');
    }
  }
  const fixtureDoc=await read(`evaluation/${w.id}.fixtures.json`);assert.equal(fixtureDoc.fixtures.length,12);
  const all=experimentSchema.parse(await read(`experiments/${w.id}-ensemble.json`));
  for(const f of fixtureDoc.fixtures) {
    fixtures++;assert.ok(!fixtureIds.has(f.id));fixtureIds.add(f.id);
    assert.equal(f.worldId,w.id);assert.equal(f.input.world,all.scenario.world);
    assert.deepEqual(f.input.characters,all.scenario.characters);
    assert.equal(f.input.targetIds.length,1);
    const target=f.input.history.find((u:any)=>u.id===f.input.targetIds[0]);assert.ok(target);
    assert.equal(new Set(f.input.history.map((u:any)=>u.id)).size,f.input.history.length);
    assert.ok(all.scenario.characters.some(c=>c.id===target.speakerId));
    dispositions[f.expected.disposition]=(dispositions[f.expected.disposition]??0)+1;
    for(const finding of f.expected.requiredFindings) {
      assert.ok(categories.includes(finding.category));assert.ok((target.speech+'\n'+target.action).includes(finding.quote));
      if(finding.reference!=='제공되지 않은 이전 발화')assert.ok(anchorIds.has(finding.reference),'참조 기준 누락');
      evaluationSchema.parse({findings:[{...finding,utteranceId:target.id}],summary:'작성자 기준 사례'});
      categoryCounts[finding.category]=(categoryCounts[finding.category]??0)+1;
    }
    const targets=f.input.history.filter((u:any)=>f.input.targetIds.includes(u.id));
    const evaluator=evaluationPrompt(all,f.input.history as any,targets as any);
    assert.ok(!evaluator.input.includes('requiredFindings'),'평가 정답이 입력에 섞임');
  }
}
const images=await read('image-manifest.json');assert.equal(images.images.length,12);assert.equal(images.portraits.length,36);
for(const img of images.images) {
  assert.ok(!path.isAbsolute(img.path));assert.ok(!img.path.includes('..'));
  const b=await readFile(path.join(root,img.path));assert.equal(b.readUInt32BE(16),img.width);assert.equal(b.readUInt32BE(20),img.height);assert.equal(b.length,img.bytes);
  assert.equal(createHash('sha256').update(b).digest('hex'),img.sha256);
  if(img.kind==='cast'){assert.equal(img.width%3,0);assert.equal(img.height%2,0);}
}
for(const p of images.portraits) {
  assert.ok(uniqueIds.has(p.characterId));const img=images.images.find((x:any)=>x.id===p.assetId);assert.ok(img);
  const r=p.rectPixels;assert.ok(r.x>=0&&r.y>=0&&r.x+r.width<=img.width&&r.y+r.height<=img.height);
  assert.equal(r.width,img.width/3);assert.equal(r.height,img.height/2);
  assert.equal(images.portraits.filter((x:any)=>x.assetId===p.assetId&&x.cellIndex===p.cellIndex).length,1);
}
const fixtureScope=['personality','speech_style','behavior','memory','knowledge','world_contradiction','world_expansion'];
assert.equal(fixtures,72);assert.equal(characters,36);assert.ok(fixtureScope.every(c=>categoryCounts[c]>=6));
const report={status:'passed',checkedAt:new Date().toISOString(),node:process.version,schemaSha256:schemaHash,promptSha256:promptHash,counts:{worlds:6,characters,scenarios:18,experiments:18,images:12,portraitRegions:36,fixtures,privateAnchorIsolationChecks:privacyChecks},fixtureDispositions:dispositions,fixtureRequiredCategories:categoryCounts,checks:['현재 Zod 스키마와 완전 일치 및 무시되는 필드 없음','3인 시나리오 12종이 36명을 빠짐없이 포함','6인 시나리오 6종과 시작 상태 독립 작성','공개 세계관·NPC persona의 비공개 정보 격리','초기 persona에 예약 사건 및 평가 정답 미포함','기억 비교 실험에서 나머지 조건 동일','평가 인용문·기준 ID·범주 연결','PNG 크기·SHA256·36개 초상 영역 경계'],limits:['실제 모델의 준수 성능을 검증한 결과가 아님','평가 fixture의 기대 판정은 작성자 기준이며 실제 평가 모델 호출은 하지 않음','현재 프로그램은 이미지 픽셀을 NPC에게 전달하지 않음']};
const reportDir=path.resolve(root,'../../.cache/npc-canon-qa');await mkdir(reportDir,{recursive:true});
await writeFile(path.join(reportDir,'validation-report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
