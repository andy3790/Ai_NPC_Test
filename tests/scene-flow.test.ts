import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { MockAdapter } from '../src/adapters/mock.js';
import { Engine } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
import { applySceneDecision, sceneDecision, sceneTurn, waitingActors } from '../src/core/scene-flow.js';
import { situationCauses } from '../src/core/situations.js';
import { spatialContract } from '../src/core/spatial-contract.js';
import { initialSpatialWorld } from '../src/core/spatial-state.js';
import { experimentSchema } from '../src/shared/schema.js';
import { spatialExample } from '../src/shared/spatial-example.js';
import type { NpcSession, Run, Utterance } from '../src/shared/types.js';
import { groupTimeCuts } from '../src/shared/scene-time.js';

// No goals, personality, event plan, or subsequent scene supplied by a user.
const bare=()=>experimentSchema.parse({schemaVersion:1,name:'방',scenario:{id:'room',name:'방',world:'작은 방.',situation:'두 사람이 있다.',
  characters:[{id:'a',name:'가람'},{id:'b',name:'유리'}],defaults:{model:'mock-model',effort:'low'}},
  variants:[{id:'ordinary',label:'기본'}],maxUtterances:5,director:{model:'mock-model',effort:'low'},
  evaluation:{enabled:false,model:'mock-model',effort:'low'}});

const line=(n:number, id:string, speech:string):Utterance=>({id:'line'+n,runId:'demo',sequence:n,speechIndex:n,
  speakerId:id,speakerName:id,kind:'speech',speech,action:'',createdAt:'',invocationId:null,deliveryCompletedAt:null,deliveryMs:null});

test('readers see contiguous quiet intervals together, with each actual choice in its original place',()=>{
  const cut=(i:number,from:number,to:number):Utterance=>({...line(i,'__clock__','30초 후.'),kind:'event',timeCut:{from,to}});
  const records=[cut(1,0,30),cut(2,30,60),line(3,'a','다 왔어.'),cut(4,61,91)];
  assert.deepEqual(groupTimeCuts(records).map(r=>r.speech),['1분 후.','다 왔어.','30초 후.']);
  assert.deepEqual(records[0].timeCut,{from:0,to:30});
});

for (const deliveryMode of ['per_utterance','batched_on_turn'] as const) {
  test('two names and one sentence can advance past a shared wait without extra receipts · '+deliveryMode,async()=>{
    const spec=bare();spec.variants[0].deliveryMode=deliveryMode;
    const store=new Store(':memory:'), adapter=new MockAdapter();adapter.delayMs=0;
    const real=adapter.turn.bind(adapter);
    const engine=new Engine(store,adapter,'.cache/scene-flow-test');
    let count=0;
    adapter.turn=async(...args)=>{
      const input=JSON.parse(args[0].input), result=await real(...args);
      if(input.task!=='speak') return result;
      const out=JSON.parse(result.output);
      ++count;
      out.speech=count===1 ? '여기서 잠깐 있자.' : count===2 ? '그러자.' : count===3 ? '좀 걸을래?' : '응.';
      out.action='';out.waitSeconds=count<=2 ? 120 : 0;
      if(count===3) {
        const source=input.sceneNow.changes.find((e:{kind:string})=>e.kind==='시간 경과');
        assert.ok(source); out.followThrough={sourceSequence:source.sequence,intention:'자리에서 일어나 산책을 제안한다.'};
      }
      result.output=JSON.stringify(out);adapter.results.set(result.turnId,result);
      if(count===3) return {...result,status:'uncertain',error:'lost acknowledgement'};
      return result;
    };
    try {
      const {runs:[run]}=await engine.create(spec);
      await engine.idle();assert.equal(engine.run(run.id).status,'paused');
      assert.equal(engine.run(run.id).sessions.a.sceneIntent,undefined);
      await engine.resume(run.id);await engine.idle();
      const d=engine.detail(run.id), cuts=d.utterances.filter(u=>u.timeCut);
      assert.equal(d.run.status,'completed',String(d.run.error));
      assert.equal(cuts.length,1); assert.equal(cuts[0].timeCut!.to,120);
      const choices=d.utterances.filter(u=>u.kind==='speech');
      assert.deepEqual(choices.slice(0,3).map(u=>u.speakerId),['a','b','a']);
      assert.equal(choices[2].sceneSeconds,120);
      assert.equal(d.run.sessions.a.sceneIntent?.sourceSequence,cuts[0].sequence);
      assert.equal(d.invocations.filter(c=>c.operationKey==='speech:3').length,1);
      assert.equal(d.receipts.filter(r=>r.utteranceId===cuts[0].id).length,0);
      assert.ok(d.invocations.filter(c=>c.kind==='speech' && c.characterId==='b').every(c=>!c.input.includes('자리에서 일어나 산책을 제안한다.')));
    } finally {await engine.close();store.close();}
  });
}

test('the single-room clock settles a due process before asking a resting NPC, including recovery after a lost reply',async()=>{
  const spec=bare();spec.variants[0].environmentMode='ai';spec.worldEngine=spec.scenario.defaults;spec.maxUtterances=4;
  const store=new Store(':memory:'),adapter=new MockAdapter();adapter.delayMs=0;
  const engine=new Engine(store,adapter,'.cache/scene-flow-test'),turn=adapter.turn.bind(adapter);
  let worldTicks=0,choices=0,deadlines=0;
  const signal='수신등에 답장이 들어왔다.';
  adapter.turn=async(...args)=>{
    const input=JSON.parse(args[0].input),result=await turn(...args),out=JSON.parse(result.output);
    if(input.task==='speak') {
      choices++;Object.assign(out,{speech:choices<=2?'잠깐 기다릴게.':'답장이 왔네.',action:'',waitSeconds:choices<=2?300:0});
      if(choices===3) {
        assert.equal(input.sceneNow.clock.elapsedSeconds,40);
        assert.ok(JSON.stringify(input.messages).includes(signal));
      }
    } else if(input.task==='environment' && ++worldTicks===1) {
      out.processes=[{id:'reply',description:'답장을 기다린다.',readyAtSeconds:40,requestNpcIds:[]}];
    } else if(input.task==='scene_deadline') {
      deadlines++;assert.deepEqual(input.due,{at:40,processIds:['reply']});assert.equal(choices,2);
      out.events=[{type:'external_signal',text:signal,npcId:null,evidence:null,processId:'reply'}];
    }
    result.output=JSON.stringify(out);adapter.results.set(result.turnId,result);
    return input.task==='scene_deadline' ? {...result,status:'uncertain',error:'lost acknowledgement'} : result;
  };
  try {
    const {runs:[run]}=await engine.create(spec);await engine.idle();
    assert.equal(engine.run(run.id).status,'paused');assert.ok(engine.run(run.id).worldState?.sceneDeadline);
    await engine.resume(run.id);await engine.idle();
    const d=engine.detail(run.id),world=d.run.worldState!;
    assert.equal(d.run.status,'completed',String(d.run.error));assert.equal(world.processedSpeechCount,4);
    assert.equal(deadlines,1);assert.equal(world.sceneDeadline,undefined);
    assert.equal(world.processes.find(p=>p.id==='reply')?.finishedAtSeconds,40);
    const heard=d.utterances.filter(u=>u.worldEvent?.text===signal);assert.equal(heard.length,1);
    assert.equal(heard[0].worldEvent!.sourceUtteranceId,null);
    assert.ok(d.utterances.find(u=>u.timeCut?.to===40)!.sequence<heard[0].sequence);
    assert.ok(heard[0].sequence<d.utterances.find(u=>u.speechIndex===3)!.sequence);
  } finally {await engine.close();store.close();}
});

test('after both people run out of things to do, an eight-hour appointment comes due within 32 choices',async()=>{
  const spec=bare();spec.variants[0].environmentMode='ai';spec.worldEngine=spec.scenario.defaults;spec.maxUtterances=32;
  const store=new Store(':memory:'),adapter=new MockAdapter();adapter.delayMs=0;
  const engine=new Engine(store,adapter,'.cache/scene-flow-test'),turn=adapter.turn.bind(adapter);
  const due=8*60*60;
  let registered=false;
  adapter.turn=async(...args)=>{
    const input=JSON.parse(args[0].input),r=await turn(...args),out=JSON.parse(r.output);
    if(input.task==='speak') Object.assign(out,{speech:'',action:registered?'':'자료 수신을 신청한다.',waitSeconds:0});
    if(input.task==='environment') {
      out.elapsedSeconds=1;
      if(!registered) {registered=true;out.processes=[{id:'reply',description:'자료 수신 예정',readyAtSeconds:due,requestNpcIds:[]}];}
    }
    if(input.task==='scene_deadline') out.events=[{type:'external_signal',text:'요청한 자료가 도착했다.',npcId:null,evidence:null,processId:'reply'}];
    r.output=JSON.stringify(out);return r;
  };
  try {
    const {runs:[run]}=await engine.create(spec);await engine.idle();
    const d=engine.detail(run.id);assert.equal(d.run.status,'completed',String(d.run.error));
    const events=d.utterances.filter(u=>u.worldEvent?.text==='요청한 자료가 도착했다.');
    assert.equal(events.length,1);assert.equal(events[0].worldEvent!.virtualSeconds,due);
    assert.ok(d.utterances.some(u=>u.kind==='speech' && u.sequence>events[0].sequence));
    assert.ok(d.utterances.some(u=>u.timeCut && u.timeCut.to-u.timeCut.from>=3600));
  } finally {await engine.close();store.close();}
});

test('a secret whisper, hidden outcome or another room cannot wake a sleeper or become their next intention',async()=>{
  const spec=bare(),store=new Store(':memory:'),engine=new Engine(store,new MockAdapter(),'.cache/scene-flow-test');
  try {
    const {runs:[initial]}=await engine.create(spec,false);
    const s:NpcSession={id:'a',threadId:'t',characterId:'a',config:spec.scenario.defaults,instructions:'',sceneWait:{from:0,until:120,sequence:1}};
    const run:Run={...initial,sessions:{a:s},sceneSeconds:10};
    const past=line(1,'a','잠깐 쉰다.');
    const hidden={...line(2,'b','가람아, 비밀 열쇠 찾아?'),perception:{locationId:'far',virtualSeconds:10,speechRecipientIds:['c'],actionRecipientIds:['a']}};
    const history=[past,hidden];
    assert.equal(waitingActors(run,history).get('a'),120);
    assert.ok(!JSON.stringify(sceneTurn(run,s,history)).includes('비밀 열쇠'));
    assert.equal(waitingActors(run,[past,{...hidden,perception:{...hidden.perception,speechRecipientIds:['a']}}]).has('a'),false);
    assert.throws(()=>sceneDecision({followThrough:{sourceSequence:2,intention:'조사한다'}},[1]));
    assert.throws(()=>sceneDecision({waitSeconds:86400},[]));
    assert.equal(waitingActors({...run,sceneFlowVersion:undefined},history).size,0);
    const empty=line(3,'a','');
    const rest=applySceneDecision({...s,sceneWait:undefined},{wait:0,intent:undefined},empty,10,true);
    assert.equal(rest.sceneWait?.until,25);
    assert.equal(applySceneDecision(rest,{wait:0,intent:undefined},empty,25,true).sceneWait?.until,55);
    assert.equal(applySceneDecision(rest,{wait:0,intent:undefined},{...empty,action:'문을 연다.'},25,true).sceneWait,undefined);
  } finally {await engine.close();store.close();}
});

test('a spatial rest stops at a local deadline and a passage closure; only the witness can choose to go elsewhere',async()=>{
  const spec=spatialExample('mock-model');spec.variants=[spec.variants[0]];spec.maxUtterances=9;spec.evaluation.enabled=false;
  spec.scenario.spatial!.connections[0].closesAtSeconds=50;
  spec.scenario.clockEvents=[{id:'lamp',atSeconds:60,text:'관제실의 표시등이 깜박인다.',locationIds:['control']}];
  const store=new Store(':memory:'),adapter=new MockAdapter();adapter.delayMs=0;
  const engine=new Engine(store,adapter,'.cache/scene-flow-test'),real=adapter.turn.bind(adapter);
  adapter.turn=async(...args)=>{
    const input=JSON.parse(args[0].input),result=await real(...args);
    if(input.task!=='speak') return result;
    const out=JSON.parse(result.output), clock=input.localContext.virtualSeconds;
    const seen=input.messages.some((m:{observation?:string})=>m.observation===spec.scenario.clockEvents![0].text);
    const cause=input.sceneNow.changes?.find((e:{observation:string})=>e.observation===spec.scenario.clockEvents![0].text);
    Object.assign(out,{speech:'',action:seen?'휴게실로 걸어간다.':'',communication:{mode:'none',targetNpcIds:[],channelId:null},
      moveToLocationId:seen?'lounge':null,waitSeconds:seen?0:300});
    if(cause && seen) out.followThrough={sourceSequence:cause.sequence,intention:'휴게실로 가서 동료를 찾는다.'};
    if(seen) assert.equal(clock,60);
    result.output=JSON.stringify(out);return result;
  };
  try {
    const {runs:[run]}=await engine.create(spec);await engine.idle();
    const d=engine.detail(run.id);assert.equal(d.run.status,'completed',String(d.run.error));
    const change=d.utterances.find(u=>u.worldEvent?.text===spec.scenario.clockEvents![0].text)!;
    assert.deepEqual(change.perception?.speechRecipientIds,['serin']);
    assert.equal(d.utterances.filter(u=>u.worldEvent?.text===change.speech).length,1);
    assert.equal(d.utterances.find(u=>u.sequence>change.sequence && u.kind==='speech')?.speakerId,'serin');
    assert.ok(d.utterances.some(u=>u.worldEvent?.text==='세린의 위치: 휴게실'));
    assert.ok(d.utterances.some(u=>u.timeCut?.to===50));
    assert.ok(d.utterances.filter(u=>u.kind==='speech' && u.speakerId!=='serin').every(u=>!u.spatialIntent?.moveToLocationId));
    assert.ok(d.run.sessions.serin.sceneIntent);
    assert.ok(d.invocations.filter(c=>c.kind==='speech' && c.characterId!=='serin').every(c=>!c.input.includes(change.speech)));
  } finally {await engine.close();store.close();}
});

test('a situation can follow a real, observed action result once; private stimuli and uncommitted attempts are excluded',()=>{
  const act=line(1,'a','아마 내일 고쳐질 거야.');
  const publicResult:Utterance={...line(2,'__environment__','진동이 멎었다.'),kind:'event',worldEvent:{type:'actor_result',npcId:'a',text:'진동이 멎었다.',sourceUtteranceId:act.id,
    virtualSeconds:20,processId:null,evidence:'private words',audience:{scope:'locations',locationIds:['room'],npcIds:[]}}};
  const privateResult:Utterance={...publicResult,sequence:3,speech:'몰래 본 쪽지',worldEvent:{...publicResult.worldEvent!,audience:{scope:'npcs',npcIds:['b'],locationIds:[]}}};
  const sources=situationCauses([act,publicResult,privateResult],[]);
  assert.deepEqual(sources,[{sequence:2,observed:'진동이 멎었다.',locationIds:['room']}]);
  const used={id:'p',invocationId:'i',title:'후속',description:'새 관찰',severity:'low' as const,locationIds:['room'],virtualSeconds:30,status:'accepted' as const,reason:null,causeSequence:2};
  assert.deepEqual(situationCauses([publicResult],[used]),[]);
});

test('an uninterrupted long break survives routine arrivals but direct questions and a real signal can interrupt',async()=>{
  const spec=spatialExample('mock-model'),store=new Store(':memory:'),engine=new Engine(store,new MockAdapter(),'.cache/scene-flow-test');
  try {
    const {runs:[initial]}=await engine.create(spec,false),actor='yoon';
    const run={...initial,sessions:{[actor]:{id:actor,characterId:actor,threadId:'t',instructions:'',config:spec.scenario.defaults,
      sceneWait:{from:0,until:300,sequence:1}}},sceneSeconds:10};
    const arrival:Utterance={...line(2,'__environment__','도하가 작업실에 도착했다.'),invocationId:'world',kind:'event',
      perception:{locationId:'workshop',virtualSeconds:10,speechRecipientIds:[actor,'miru'],actionRecipientIds:[]},
      worldEvent:{type:'actor_result',npcId:'doha',sourceUtteranceId:'walk',virtualSeconds:10,evidence:'걸어간다',processId:null,text:'도하의 위치: 작업실'}};
    assert.equal(waitingActors(run,[arrival]).get(actor),300);
    assert.equal(waitingActors({...run,sceneFlowVersion:'scene-flow/1'},[arrival]).size,0);
    const near={...line(3,'doha','차 마실래?'),perception:arrival.perception};
    assert.equal(waitingActors(run,[near]).get(actor),300);
    assert.equal(waitingActors(run,[{...near,speech:'윤, 차 마실래?'}]).size,0);
    assert.equal(waitingActors(run,[{...arrival,worldEvent:{...arrival.worldEvent!,type:'external_signal',npcId:null}}]).size,0);
    const from=91.46363636363635;
    const fractional={...run,sceneSeconds:from+1,sessions:{[actor]:{...run.sessions[actor],sceneWait:{from,until:from+120,sequence:1}}}};
    assert.equal(waitingActors(fractional,[arrival]).get(actor),from+120);
    assert.equal(waitingActors({...fractional,sceneFlowVersion:'scene-flow/2'},[arrival]).size,0);
  } finally {await engine.close();store.close();}
});

test('when one NPC never departed, the resolver cannot assign them the arrival of a different traveller',()=>{
  const spec=spatialExample('mock-model'),state=initialSpatialWorld(spec),space=state.spatial!;
  state.virtualSeconds=40;
  for(const [actor,arrival] of [['yoon',40],['serin',50]] as const) {
    space.activities.push({id:actor+'-action',npcId:actor,sourceUtteranceId:actor+'-action',kind:'action',status:'pending',
      reason:null,startedAtSeconds:3,readyAtSeconds:arrival,speakingUntilSeconds:0,finishedAtSeconds:null,
      locationId:'lounge',moveToLocationId:actor==='yoon'?'workshop':'control',waitingNpcIds:[],offeredNpcIds:[]});
  }
  Object.assign(space.positions.find(p=>p.npcId==='serin')!,{locationId:null,transit:{from:'lounge',to:'control',connectionId:'lounge-control',activityId:'serin-action'}});
  const schema=()=>z.fromJSONSchema(spatialContract('resolve',spec,state,[],[],true));
  const out={completedActivities:[],activityUpdates:[],facts:[],forgetFactIds:[],processes:[],finishProcesses:[],events:[],proposalDecision:null,movements:[]};
  const requested={kind:'requested',npcId:'serin',toLocationId:'control',activityId:'serin-action'};
  assert.ok(schema().safeParse(out).success);
  assert.equal(schema().safeParse({...out,movements:[requested]}).success,false);
  state.virtualSeconds=50;
  assert.ok(schema().safeParse({...out,movements:[requested]}).success);
  assert.equal(schema().safeParse({...out,movements:[{...requested,npcId:'yoon',toLocationId:'workshop'}]}).success,false);
});
