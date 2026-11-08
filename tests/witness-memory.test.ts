import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockAdapter } from '../src/adapters/mock.js';
import { Engine } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
import { WitnessMemory } from '../src/core/witness-memory.js';
import { experimentSchema } from '../src/shared/schema.js';
import type { Utterance } from '../src/shared/types.js';

const cast=[{id:'a',name:'나래'},{id:'b',name:'민호'},{id:'c',name:'지수'},{id:'d',name:'해솔'}];
const places=[{id:'shed',name:'창고'},{id:'yard',name:'마당'}];
const memory=()=>new WitnessMemory(cast,places);
const line=(sequence:number,speakerId:string,speech:string,heard:string[],action='',seen:string[]=[],place='shed'):Utterance=>({
  id:'line'+sequence,runId:'test',sequence,speechIndex:sequence,kind:'speech',speakerId,speakerName:speakerId,speech,action,
  perception:{locationId:place,virtualSeconds:sequence,speechRecipientIds:heard,actionRecipientIds:seen},
  createdAt:'',invocationId:null,deliveryCompletedAt:null,deliveryMs:null,
});
const event=(sequence:number,text:string,heard:string[],place='shed'):Utterance=>({
  ...line(sequence,'__world__',text,heard,'',[],place),kind:'event',speechIndex:null,
});
const ask=line(1,'a','민호 씨, 손목은 괜찮아요?',['b','c'],'손을 든다.',['d']);
const otherAsk='민호, 손목은 좀 나아졌어?';

test('only people who heard a question hold it for the same addressee and subject',()=>{
  const index=memory().observe([ask]);
  const edit=(id:string,speech:string)=>index.edit(index.view(id,2),id,'shed',{speech,action:'팔짱을 낀다.'});
  assert.deepEqual(edit('c',otherAsk+' 점심 먹으러 갈까?')?.patch,{speech:'점심 먹으러 갈까?'});
  assert.equal(edit('a','민호 씨, 손목은 괜찮으세요?')?.patch.speech,'');
  assert.equal(edit('c','나래, 손목은 좀 나아졌어?'),undefined);
  assert.equal(edit('c','민호, 무릎은 좀 나아졌어?'),undefined);
  assert.equal(edit('c','민호, 다시 물어볼게. 대답해, 손목은 괜찮냐?'),undefined);
  assert.equal(edit('d',otherAsk),undefined);
  assert.equal(index.context(index.view('d',2),'shed'),undefined);
  assert.equal(index.edit(index.view('c',301),'c','shed',{speech:otherAsk,action:''}),undefined);
  assert.equal(memory().observe([line(1,'a','손목은 괜찮아?',['b','c'])]).view('c',1).questions.length,0);
  assert.equal(memory().observe([line(1,'a','민호, 손목은 괜찮아?',['c'])]).view('c',1).questions.length,0);
});

test('the addressed person supplies the answer and only a witnessed change reopens it',()=>{
  const rows=[ask,line(2,'c','내 손목은 괜찮아.',['a','b']),line(3,'b','손목은 이제 괜찮아.',['a','c'])];
  const index=memory().observe(rows.slice(0,2));
  assert.equal(index.view('a',2).questions[0].answer,undefined);
  index.observe(rows);
  assert.equal(index.view('c',3).questions[0].answer,rows[2].speech);
  const privateSignal=event(4,'민호가 손목이 다시 아프다고 한다.',['a']);
  index.observe([...rows,privateSignal]);
  assert.equal(index.view('a',4).questions.length,0);
  assert.equal(index.view('c',4).questions.length,1);
  const observed=line(5,'b','',[],'손목이 다시 아파 움켜쥔다.',['c']);
  index.observe([...rows,privateSignal,observed]);
  assert.equal(index.view('c',5).questions.length,0);
  assert.deepEqual(index.observe(rows).view('c',3),memory().observe(rows).view('c',3));
  const general=line(1,'a','민호, 괜찮아?',['b','c']);
  const effect:Utterance={...event(2,'손끝 감각이 둔해진다.',['a']),
    worldEvent:{type:'physical_effect',npcId:'b',text:'손끝 감각이 둔해진다.',evidence:null,processId:null,sourceUtteranceId:null,virtualSeconds:2}};
  const changed=memory().observe([general,effect]);
  assert.equal(changed.view('a',2).questions.length,0);assert.equal(changed.view('c',2).questions.length,1);
});

test('only a witnessed, conclusive result closes the checked component at its location',()=>{
  const attempt=line(1,'a','',[],'송풍기 덮개와 나사 상태를 확인한다.',['b']);
  const outcome:Utterance={...event(2,'송풍기 덮개와 나사는 단단히 고정되어 있다.',['a','b','c']),
    resolution:{sourceUtteranceId:attempt.id,actionId:'inspect',actorId:'a',speechIndex:1,before:{},after:{}}};
  const index=memory().observe([attempt]);
  const check={speech:'',action:'송풍기 덮개와 나사를 살펴본다.'};
  const edit=(who='a',action=check.action,place='shed')=>index.edit(index.view(who,10),who,place,{...check,action});
  assert.equal(edit(),undefined);
  index.observe([attempt,outcome]);
  assert.equal(edit()?.patch.action,'');
  assert.equal(edit('b')?.patch.action,'');
  assert.equal(edit('c')?.patch.action,'');
  assert.equal(new WitnessMemory(cast,places,'witness-memory/1').observe([attempt,outcome]).view('c',2).checks.length,0);
  assert.equal(edit('a',check.action,'yard'),undefined);
  assert.equal(edit('a','송풍기 베어링 온도를 측정한다.'),undefined);
  assert.equal(edit('a','송풍기 덮개를 확인하고 물병을 챙긴다.'),undefined);
  assert.equal(index.edit(index.view('a',10),'a','shed',{...check,activityChoice:'continue'}),undefined);
  const trip=index.edit(index.view('a',10),'a','yard',{speech:'곧 올게. 창고 가서 송풍기 점검할게.',action:'',
    moveToLocationId:'shed',followThrough:{intention:'송풍기 덮개를 확인한다.'}});
  assert.deepEqual(trip?.patch,{speech:'곧 올게.',moveToLocationId:null,followThrough:null});
  const leave={speech:'송풍기 확인하러 갈게.',action:'자리에서 일어나 마당을 나선다.',moveToLocationId:'shed'};
  assert.deepEqual(index.edit(index.view('a',10),'a','yard',leave)?.patch,{speech:'',action:'',moveToLocationId:null});
  assert.equal(index.edit(index.view('a',10),'a','yard',{...leave,speech:'물병도 가져올게. '+leave.speech})?.patch.moveToLocationId,undefined);
  assert.equal(index.edit(index.view('a',10),'a','yard',{...leave,action:'문을 잠그고 창고로 향한다.'})?.patch.action,undefined);
  assert.deepEqual(index.edit(index.view('a',10),'a','yard',{
    ...leave,speech:'난 잠깐 쉴래. 창고 송풍기 보러 갈게.',action:'의자에서 일어나 마당을 나선다.',
  })?.patch,{speech:'난 잠깐 쉴래.',action:'',moveToLocationId:null});
  const previous=new WitnessMemory(cast,places,'witness-memory/2').observe([attempt,outcome]);
  assert.equal(previous.edit(previous.view('a',10),'a','yard',{...leave,speech:'창고 송풍기 보러 갈게.'}),undefined);
  assert.equal(edit('a','송풍기 덮개를 손으로 살짝 눌러 흔들림이 있는지 확인한다.')?.patch.action,'');
  assert.equal(index.edit(index.view('a',10),'a','yard',{...leave,speech:'창고 송풍기 옆 공구를 보러 갈게.'}),undefined);
  assert.equal(index.edit(index.view('a',10),'a','shed',{speech:'송풍기 보러 갔어.',action:''}),undefined);
  const more=[event(3,'송풍기 덮개가 풀리면 알려 줘.',['a']),event(4,'다른 라디오 소리가 다시 커졌다.',['a']),
    event(5,'송풍기 덮개 나사가 다시 풀렸다.',['a'],'yard'),event(6,'송풍기 덮개 나사가 다시 풀렸다.',['d'])];
  index.observe([attempt,outcome,...more]);
  assert.equal(edit()?.patch.action,'');
  index.observe([attempt,outcome,...more,event(7,'송풍기 덮개 나사가 다시 풀렸다.',['a'])]);
  assert.equal(edit(),undefined);
  assert.equal(edit('b')?.patch.action,'');
  const pending={...outcome,id:'pending',speech:'덮개는 단단하지만 송풍기 상태는 아직 확인할 수 없다.'};
  assert.equal(memory().observe([attempt,pending]).view('a',3).checks.length,0);
  const noisy=memory().observe([attempt,outcome,event(3,'송풍기에서 쇳소리가 난다.',['a'])]);
  assert.equal(noisy.edit(noisy.view('a',4),'a','shed',check),undefined);
  const persists=memory().observe([attempt,outcome,{...outcome,id:'later',sequence:3,speech:'덮개는 단단하지만 송풍기의 진동음은 계속 난다.'}]);
  assert.equal(persists.edit(persists.view('a',4),'a','shed',check),undefined);
});

test('a witnessed repair result is sufficient, including for someone who never saw the private action',()=>{
  const attempt=line(1,'a','',[],'송풍기 덮개 뒤의 비상 스위치를 돌린다.',[],'yard');
  const result:Utterance={...event(2,'덮개 나사가 조여지며 송풍기 진동음이 잦아든다.',['a','b']),
    worldEvent:{type:'actor_result',npcId:'a',text:'덮개 나사가 조여지며 송풍기 진동음이 잦아든다.',evidence:attempt.action,processId:null,sourceUtteranceId:attempt.id,virtualSeconds:2}};
  const index=memory().observe([attempt,result]);
  assert.equal(index.edit(index.view('a',2),'a','shed',{speech:'',action:'송풍기를 점검한다.'})?.patch.action,'');
  const view=index.view('b',2);
  assert.equal(view.checks.length,1);assert.doesNotMatch(JSON.stringify(view),/스위치|비상|yard/);
  assert.equal(index.edit(view,'b','shed',{speech:'',action:'송풍기 덮개를 점검한다.'})?.patch.action,'');
  assert.equal(index.view('c',2).checks.length,0);
  assert.equal(memory().observe([attempt,{...result,speech:'송풍기 덮개는 단단하지 않다.'}]).view('a',2).checks.length,0);
});

for (const deliveryMode of ['per_utterance','batched_on_turn'] as const) {
  test('committed speech, original provider output and receipts survive recovery · '+deliveryMode,async()=>{
    const spec=experimentSchema.parse({schemaVersion:1,name:'마당',scenario:{id:'yard',name:'마당',world:'마당.',situation:'셋이 마주친다.',
      characters:[cast[0],cast[2],cast[1]],defaults:{model:'mock-model',effort:'low'}},variants:[{id:'round',label:'차례',deliveryMode}],
      maxUtterances:3,director:{model:'mock-model',effort:'low'},evaluation:{enabled:false,model:'mock-model',effort:'low'}});
    const store=new Store(':memory:'),adapter=new MockAdapter();adapter.delayMs=0;
    const engine=new Engine(store,adapter,'.cache/witness-tests'),original=adapter.turn.bind(adapter);
    let choices=0;
    adapter.turn=async(...args)=>{
      const input=JSON.parse(args[0].input),result=await original(...args);
      if (input.task!=='speak') return result;
      choices++;
      if (choices===2) assert.ok(JSON.stringify(input.witnessed).includes('손목'));
      const out=JSON.parse(result.output);
      Object.assign(out,{speech:[ask.speech,otherAsk,'이제 괜찮아.'][choices-1],action:'',waitSeconds:0});
      result.output=JSON.stringify(out);adapter.results.set(result.turnId,result);
      return choices===2 ? {...result,status:'uncertain',error:'lost acknowledgement'} : result;
    };
    try {
      const {runs:[run]}=await engine.create(spec);await engine.idle();
      assert.equal(engine.run(run.id).status,'paused',String(engine.run(run.id).error));
      await engine.inject(run.id,'민호가 손목이 다시 아프다고 한다.');
      await engine.resume(run.id);await engine.idle();
      const d=engine.detail(run.id),second=d.utterances.find(u=>u.speechIndex===2)!;
      assert.equal(d.run.witnessMemoryVersion,'witness-memory/2');
      assert.equal(d.run.status,'completed',String(d.run.error));assert.equal(choices,3);
      assert.equal(second.speech,'');assert.equal(d.receipts.filter(r=>r.utteranceId===second.id).length,0);
      const call=d.invocations.find(c=>c.id===second.invocationId)!;
      assert.equal(JSON.parse(call.output).speech,otherAsk);assert.ok(call.metadata.witnessEdit);
    } finally {await engine.close();store.close();}
  });
}
