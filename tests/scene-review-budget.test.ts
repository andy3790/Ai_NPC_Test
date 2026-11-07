import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ReviewBudget, reviewBudgetFile } from '../scripts/review-budget.js';
import { emptyUsage } from '../src/core/metrics.js';

test('review workers share reservations, settle known usage and preserve the cap after restart', async t => {
  t.mock.method(globalThis,'fetch',async () => new Response(null,{status:200}));
  const file=reviewBudgetFile(await mkdtemp(resolve('.cache/history-test-budget-')));
  const limit=0.001;
  const request=(worker:ReviewBudget,id:string,output:number) => worker.fetch('https://api.openai.com/v1/responses',{
    method:'POST',redirect:'error',body:JSON.stringify({model:'gpt-6-luna',reasoning:{effort:'low'},
      max_output_tokens:output,metadata:{npc_lab_call_id:id}}),
  });
  using first=new ReviewBudget(file,limit), second=new ReviewBudget(file,limit);
  await request(first,'one',512);
  const reserve=first.total();
  assert.ok(reserve>0 && reserve<=limit);
  assert.equal(second.total(),reserve);
  second.settle('one',{turnId:'known',output:'',status:'uncertain'});
  assert.equal(first.total(),reserve);
  await assert.rejects(request(second,'expensive',1_000_000),/before dispatch/);
  first.settle('one',{turnId:'known',output:'',status:'completed',usage:{
    ...emptyUsage(),inputTokens:10,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:5,
  }});
  assert.ok(second.total()>0 && second.total()<reserve);
  using restarted=new ReviewBudget(file,limit);
  assert.equal(restarted.total(),first.total());
  assert.throws(() => new ReviewBudget(file,limit*2),/budget differs/);
});
