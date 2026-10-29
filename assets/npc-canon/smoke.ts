import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { Store } from '../../src/core/store.js';
import { Engine } from '../../src/core/engine.js';
import { MockAdapter } from '../../src/adapters/mock.js';
import { exportFiles } from '../../src/core/export.js';
import { experimentSchema } from '../../src/shared/schema.js';
import { root, worlds, experiment, parts } from './build.mjs';
const results=[];
for(const w of worlds) {
  const spec=experimentSchema.parse(experiment(w,parts(w)[0],'mock-model','low'));
  spec.maxUtterances=16;
  const store=new Store(':memory:');const adapter=new MockAdapter();adapter.delayMs=1;
  const engine=new Engine(store,adapter,path.resolve(root,'../../.cache/npc-canon-qa/runtime'));
  try {
    const {runs}=await engine.create(spec);await engine.idle();assert.equal(runs.length,2);
    const counts=[];
    for(const r of runs) {
      const d=engine.detail(r.id);assert.equal(d.run.status,'completed',d.run.error??undefined);
      const speech=d.utterances.filter(u=>u.kind==='speech');assert.equal(speech.length,16);
      const events=d.utterances.filter(u=>u.kind==='event');assert.equal(events.length,1);assert.equal(events[0].speech,w.events[0].text);
      assert.equal(d.utterances.slice(0,d.utterances.indexOf(events[0])).filter(u=>u.kind==='speech').length,12);
      assert.equal(d.evaluations.length,2);assert.ok(d.evaluations.every(e=>e.status==='completed'));
      for(const inv of d.invocations.filter(i=>i.kind==='speech')) {
        const input=JSON.parse(inv.input);assert.equal(!!input.originalCharacterAndWorld,d.run.variant.memoryMode==='reinject_on_speech');
      }
      for(const inv of d.invocations.filter(i=>i.kind==='evaluation'))assert.ok(!inv.input.includes('requiredFindings'));
      const files=exportFiles(d,store.events(r.id));assert.ok(Object.keys(files).some(f=>f.endsWith('.csv')));assert.ok(Object.keys(files).some(f=>f.endsWith('.jsonl')));
      counts.push({memoryMode:d.run.variant.memoryMode,speeches:speech.length,events:events.length,evaluations:d.evaluations.length,exportFiles:Object.keys(files).length});
    }
    results.push({world:w.id,status:'passed',runs:counts});
  }finally{await engine.close();store.close();}
}
const report={status:'passed',checkedAt:new Date().toISOString(),adapter:'mock',worlds:results.length,runs:results.reduce((n,r)=>n+r.runs.length,0),speeches:results.reduce((n,r)=>n+r.runs.reduce((s,x)=>s+x.speeches,0),0),results,scope:'에셋 JSON을 현재 Engine에 넣어 세션 생성·두 기억 방식·12발화 사건·평가 구간·내보내기 연결만 검증. MockAdapter는 기존 등대 대사를 고정 출력하므로 이 결과는 세계관·캐릭터 준수나 평가 정확도의 검증이 아니다.'};
const reportDir=path.resolve(root,'../../.cache/npc-canon-qa');await mkdir(reportDir,{recursive:true});
await writeFile(path.join(reportDir,'smoke-report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
