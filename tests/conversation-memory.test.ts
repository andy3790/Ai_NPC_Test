import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { checkProspectiveClaim, checkQuietDisclosure, conversationMemory, rememberSource, withMemoryCheckpoint } from '../src/core/conversation-memory.js';
import { committedPerformance, parseSpeechOutput, performTurn, sparseFollowUp, withPortrayal, withSpeechUnits } from '../src/core/character-performance.js';
import { languageRepairSchema } from '../src/core/actor-context.js';
import { characterSchema, outputSchemas } from '../src/shared/schema.js';
import { phrasingChoices } from '../src/shared/character-performance.js';
import { exampleSpec } from '../src/shared/example.js';
import { Engine } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
import { MockAdapter } from '../src/adapters/mock.js';
import type { InvocationMetrics, Utterance } from '../src/shared/types.js';

function line(sequence: number, speakerId: string, speech: string, listeners = ['a','b'], action = '', observers = listeners): Utterance {
  return {sequence,id:'u'+sequence,speakerId,speakerName:speakerId,speech,action,kind:'speech',perception:{
    virtualSeconds:sequence,locationId:'room',speechRecipientIds:listeners,actionRecipientIds:observers,
  }} as Utterance;
}

test('a checkpoint offers witnessed sources, keeps fresh questions and outcomes, and retrieves the actor’s own selections', () => {
  const h = Array.from({length:7},(_,i) => line(i+1,i%2===0?'b':'a',i===6?'포장지 색깔을 바꾼 이유가 있어?':'포장지는 이 색깔로 하자.'));
  h.push(line(8,'c','다른 방의 비밀 표식',[],'연필을 집는다.',['a']));
  h.push({...line(9,'world','포장지 색깔이 달라졌다.'),kind:'event'});
  const mem = conversationMemory(h,'a',[1,8],new Set(['u7','u9']));
  assert.ok(mem.offered.includes(9));
  assert.ok(mem.omit.size>0 && !mem.omit.has(7) && !mem.omit.has(9));
  assert.ok(mem.context.repeatedExchange && mem.context.setAside?.some(u=>u.sequence===1));
  assert.ok(!JSON.stringify(mem.context).includes('비밀'));
  const other=conversationMemory(h,'d',[1,8],new Set());
  assert.deepEqual(other.offered,[]);
  assert.deepEqual(other.context,{});
  assert.deepEqual(rememberSource([1,2,3,4],9,mem.offered),[2,3,4,9]);
  for (const v of [100,null,'9']) assert.deepEqual(rememberSource([1],v,mem.offered),[1]);
  const schema = z.fromJSONSchema(withMemoryCheckpoint(outputSchemas.speech,mem.offered));
  assert.ok(schema.safeParse({speech:'',action:'',setAsideSequence:null}).success);
  assert.ok(!schema.safeParse({speech:'',action:'',setAsideSequence:100}).success);
  assert.equal(withMemoryCheckpoint(outputSchemas.speech,[]),outputSchemas.speech);
  const unrelated = Array.from({length:40},(_,i) => line(10+i,'b','책장 앞에 앉는다.'));
  assert.equal(conversationMemory([...h,...unrelated],'a',[1],new Set()).context.setAside,undefined);
  const later=conversationMemory([...h,...unrelated,line(50,'b','포장지 색깔이 다시 바뀌었어?')],'a',[1],new Set(['u50']));
  assert.deepEqual(later.context.setAside?.map(x=>x.sequence),[1]);
  assert.ok(!later.omit.has(50));
});

test('a sparse cast gets modest distinct phrasing while authored voices and older versions retain their choices', () => {
  const c=characterSchema.parse({id:'a',name:'진',identity:'문서 담당',goals:'문구를 확인한다.'});
  const call={id:'accepted',output:JSON.stringify({portrayal:{attention:'바로 손댈 일',phrasing:'대답을 먼저 건넨다'}})} as InvocationMetrics;
  for (let slot=0;slot<3;slot++) {
    const turn=performTurn('character-performance/3',c,slot,{},[]);
    assert.equal(turn.fixedPhrasing,phrasingChoices[slot]);
    const schema=z.fromJSONSchema(withPortrayal(outputSchemas.speech,turn.fixedPhrasing));
    const body={speech:'',action:'',portrayal:{attention:'바로 손댈 일',phrasing:phrasingChoices[slot]}};
    assert.ok(schema.safeParse(body).success);
    assert.ok(!schema.safeParse({...body,portrayal:{...body.portrayal,phrasing:phrasingChoices[(slot+1)%3]}}).success);
    assert.deepEqual(committedPerformance('character-performance/3',c,slot,call).choices,body.portrayal);
  }
  assert.equal(performTurn('character-performance/2',c,1,{},[]).fixedPhrasing,undefined);
  assert.equal(performTurn('character-performance/3',{...c,speechStyle:'간결한 반말'},1,{},[]).fixedPhrasing,undefined);
});

test('quiet turns resume on a fresh visible event, a direct question or pending work', () => {
  const h=[line(1,'a','낡은 자물쇠는 그만 보자.'),line(2,'b','그래.'),line(3,'a','')];
  const atRest=conversationMemory(h,'a',[1],new Set());
  assert.ok(atRest.quiet);
  assert.deepEqual(atRest.offered,[]);
  assert.equal(atRest.context.repeatedExchange,undefined);
  assert.equal(conversationMemory(h,'a',[1],new Set(),'conversation-memory/1').quiet,false);
  assert.equal(conversationMemory(h,'a',[1],new Set(),'conversation-memory/2','',true).quiet,false);
  const privateEvent={...line(4,'world','혼자 들은 소리',[]),kind:'event' as const};
  assert.ok(conversationMemory([...h,privateEvent],'a',[1],new Set()).quiet);
  const changed={...line(5,'world','자물쇠가 바닥에 떨어졌다.'),kind:'event' as const};
  assert.equal(conversationMemory([...h,changed],'a',[1],new Set(['u5'])).quiet,false);
  assert.equal(conversationMemory([...h,line(6,'b','아까 열쇠는 어디에 뒀어?')],'a',[1],new Set(['u6'])).quiet,false);
});

test('sparse turns give complete thoughts room and release for events, explanations, or an authored voice', () => {
  const actor=characterSchema.parse({id:'a',name:'진',identity:'운영 담당',goals:'결과 확인'});
  const h=[line(1,'a','먼저 확인해 볼게요.'),line(2,'a','그 정도면 됐습니다.')].map(u=>({...u,perception:undefined}));
  const note=sparseFollowUp(actor,0,h,true)!;
  assert.ok(note && note.cadence.includes('존대'));
  assert.ok(sparseFollowUp(actor,1,h,true)!.units>note.units);
  assert.equal(sparseFollowUp(actor,0,h,false),undefined);
  assert.equal(sparseFollowUp({...actor,speechStyle:'짧은 반말'},0,h,true),undefined);
  assert.equal(sparseFollowUp(actor,0,[...h,line(3,'b','수치를 각각 설명해 주시겠어요?')],true),undefined);
  assert.equal(sparseFollowUp(actor,0,[...h,{...line(3,'world','새 공지가 붙는다.'),kind:'event'}],true),undefined);
});

test('complete speech units survive delivery intact, and retry validates language inside each unit', () => {
  const raw=withSpeechUnits(outputSchemas.speech,2);
  const schema=z.fromJSONSchema(raw);
  const a='처음 확인했을 때 봤던 자국은 겉에만 있었지만, 그다음에 들어온 상자까지 따로 살펴보기 전에는 여기서 결과를 미리 말하기 어렵겠어요.';
  const b='확인하고 연락드릴게요.';
  const decode=(speech:unknown)=>parseSpeechOutput({output:JSON.stringify({speech,action:''}),metadata:{sparseVoiceVersion:'sparse-voice/2',speechUnits:2}}).speech;
  assert.ok(schema.safeParse({speech:[a,b],action:''}).success);
  assert.equal(decode([a,b]),a+' '+b);
  assert.equal(decode([]),'');
  for (const invalid of [[a,b,b],['  '],[1],a]) assert.throws(()=>decode(invalid));
  assert.equal(parseSpeechOutput({output:JSON.stringify({speech:a}),metadata:{sparseVoiceVersion:'sparse-voice/1'}}).speech,a);
  const repair=languageRepairSchema(raw,'한국어 장면','장면과 인물에게 없는 가나 단어가 섞였습니다. 관찰한 뜻을 한국어로 자연스럽게 다시 표현하세요.')!;
  const retried=z.fromJSONSchema(repair);
  assert.ok(retried.safeParse({speech:[a,b],action:''}).success);
  assert.ok(!retried.safeParse({speech:['과수で 확인했어요.'],action:''}).success);
});

test('a goal reminder pairs only an observed result with the actor’s own committed attempt', () => {
  const h=[line(1,'a','',[],'잠금장치를 살핀다.',['a'])];
  h.push(line(2,'a','잠금장치 소리가 났어.'),line(3,'a','잠금장치를 보자.'));
  const outcome={...line(4,'world','걸쇠는 이미 제자리에 있다.',['a']),kind:'event' as const,
    worldEvent:{type:'actor_result',npcId:'a',sourceUtteranceId:'u1'} as Utterance['worldEvent']};
  const result=conversationMemory([...h,outcome],'a',[],new Set(),'conversation-memory/2','잠금장치를 확인한다.');
  assert.deepEqual(result.context.lastGoalObservation,{attempt:'잠금장치를 살핀다.',result:{sequence:4,speaker:'world',kind:'관찰',quote:outcome.speech}});
  assert.equal(conversationMemory(h,'a',[],new Set(),'conversation-memory/2','잠금장치를 확인한다.').context.lastGoalObservation,undefined);
  assert.equal(conversationMemory([...h,{...outcome,perception:{...outcome.perception!,speechRecipientIds:[],actionRecipientIds:[]}}],'a',[],new Set(),'conversation-memory/2','잠금장치를 확인한다.').context.lastGoalObservation,undefined);
});

test('a hypothetical object stays prospective across deliveries, with room for a later time jump or an established memory', () => {
  const promise=line(1,'a','그럼 손잡이가 삐뚤어져도 귀라고 우기면 되겠다. 수업에서 그런 컵 나오면 사진 찍어 보여줄게.');
  const question=line(3,'b','아까 말한 삐뚤어진 손잡이 얘기, 다음엔 꼭 들려줘.');
  const h=[promise,line(2,'a','다음에 보자.'),question];
  const invalid='응, 다음에 보여줄게. 손잡이가 한쪽으로 기울었는데, 그게 또 나름 마음에 들더라.';
  for (const fresh of [new Set(['u3']),new Set<string>()]) {
    const prospect=conversationMemory(h,'a',[],fresh,'conversation-memory/3').context.prospective;
    assert.equal(prospect?.sequence,1);
    assert.throws(()=>checkProspectiveClaim(invalid,prospect,''),/직접 겪은 기억/);
    assert.doesNotThrow(()=>checkProspectiveClaim('그런 손잡이가 나오면 보여줄게.',prospect,''));
    assert.doesNotThrow(()=>checkProspectiveClaim(invalid,prospect,'어릴 때 손잡이가 기울어진 물건을 만들어 봤다.'));
  }
  const passage={...line(4,'world','몇 주 후, 다시 모인다.'),kind:'event' as const};
  assert.equal(conversationMemory([...h,passage,line(5,'b',question.speech)],'a',[],new Set(['u5']),'conversation-memory/3').context.prospective,undefined);
  assert.equal(conversationMemory(h,'a',[],new Set(['u3']),'conversation-memory/2').context.prospective,undefined);
});

test('after a pause the same news is already known only to its actual listeners', () => {
  const known=[{said:'응, 이번엔 물 찾을 정도는 아니네. 나 어제 도예 수업 신청했어. 다음 주부터 8주 동안이야.',heardBy:['은서','나래']}];
  const listeners=['은서','나래'];
  assert.throws(()=>checkQuietDisclosure('케이크 먹기 전에 하나 말해도 돼? 나 어제 도예 수업 신청했어.',known,listeners),/이미 들은 소식/);
  assert.throws(()=>checkQuietDisclosure('아, 나 어제 도예 수업 신청했어. 다음 주부터 수요일 저녁이야.',known,listeners),/이미 들은 소식/);
  for (const speech of ['나 어제 도예 수업 신청했어?', '아까 말했듯이 나 어제 도예 수업 신청했어.', '아, 나 오늘 다른 수업 신청했어.'])
    assert.doesNotThrow(()=>checkQuietDisclosure(speech,known,listeners));
  assert.doesNotThrow(()=>checkQuietDisclosure('나 어제 도예 수업 신청했어.',known,[...listeners,'새 손님']));
});

test('an independent quiet turn keeps the first disclosure and the people who heard it', async () => {
  const store=new Store(':memory:'), adapter=new MockAdapter();
  adapter.name='openai'; adapter.delayMs=0;
  const spec=exampleSpec('mock-model');
  delete spec.scenario.environment;
  const news='어제 도예 수업을 신청했어요. 다음 주부터 수요일 저녁에 수업을 들어요.';
  spec.scenario.characters=[characterSchema.parse({id:'a',name:'윤',goals:news}),characterSchema.parse({id:'b',name:'미루'})];
  spec.scheduledEvents=[]; spec.maxUtterances=11; spec.evaluation.enabled=false;
  spec.variants=[{...spec.variants[0],environmentMode:'off',turnPolicy:'round_robin',stopOnSilence:false}];
  const utterances=[news,'그렇구나.','오늘 물잔은 어디에 두셨어요?','선반 위에 있어.','여기 연필도 하나 있어요.','그건 내 거야.',
    '집에 가기 전에 버스 시간부터 볼게요.','창밖에 벌써 저녁빛이네.','','',''];
  const turn=adapter.turn.bind(adapter);
  adapter.turn=async (...args)=>{
    const result=await turn(...args);
    if (JSON.parse(args[0].input).task==='speak') {
      const raw=JSON.parse(result.output), speech=utterances.shift()!;
      result.output=JSON.stringify({...raw,speech:Array.isArray(raw.speech) ? speech ? [speech] : [] : speech,action:''});
    }
    return result;
  };
  const engine=new Engine(store,adapter,'.cache/history-test-quiet-listeners');
  try {
    const {runs:[run]}=await engine.create(spec);
    await engine.idle();
    assert.equal(engine.run(run.id).status,'completed');
    const input=JSON.parse(store.attempts(run.id,'speech:11')[0].input);
    assert.ok(input.conversationMemory.quiet);
    assert.deepEqual(input.alreadyTold,[{sequence:1,said:news,heardBy:['미루']}]);
    assert.deepEqual(input.messages,[]);
  } finally {await engine.close();store.close();}
});

test('replaying a checkpoint commits the private selection once together with its public choice', async () => {
  const store=new Store(':memory:'), adapter=new MockAdapter();
  adapter.delayMs=0;
  const turn=adapter.turn.bind(adapter);
  adapter.turn=async (...args) => {
    const result=await turn(...args);
    const sources=JSON.parse(args[0].input).conversationMemory?.sources;
    if (sources?.length) result.output=JSON.stringify({...JSON.parse(result.output),setAsideSequence:sources[0].sequence});
    return result;
  };
  const spec=exampleSpec('mock-model');
  delete spec.scenario.environment;
  spec.scheduledEvents=[]; spec.scenario.characters=spec.scenario.characters.slice(0,2);
  spec.variants=[{...spec.variants[0],environmentMode:'off',turnPolicy:'round_robin'}];
  spec.evaluation.enabled=false; spec.maxUtterances=10;
  let engine=new Engine(store,adapter,'.cache/history-test-checkpoint');
  try {
    const {runs:[run]}=await engine.create(spec,false);
    let interrupt=true;
    const put=store.put.bind(store);
    store.put=(table,record) => {
      if (interrupt && table==='utterances' && 'speechIndex' in record && record.speechIndex===7) {
        interrupt=false;
        throw Error('simulate interrupted checkpoint commit');
      }
      return put(table,record);
    };
    await engine.resume(run.id); await engine.idle();
    const actor=spec.scenario.characters[0].id;
    assert.equal(engine.run(run.id).status,'paused');
    assert.equal(engine.run(run.id).sessions[actor].setAsideSequences,undefined);
    const before=store.attempts(run.id,'speech:7');
    assert.equal(before.length,1);
    const selected=JSON.parse(before[0].output).setAsideSequence;
    assert.equal(typeof selected,'number');
    await engine.close();
    engine=new Engine(store,adapter,'.cache/history-test-checkpoint');
    await engine.resume(run.id); await engine.idle();
    assert.equal(engine.run(run.id).status,'completed');
    assert.deepEqual(engine.run(run.id).sessions[actor].setAsideSequences,[selected]);
    assert.equal(store.attempts(run.id,'speech:7').length,1);
    assert.ok(store.list('utterances',run.id).every(u=>!('setAsideSequence' in u)));
  } finally { await engine.close(); store.close(); }
});

test('reconciling a sparse speech publishes and delivers the complete stored provider response once', async () => {
  const store=new Store(':memory:'), adapter=new MockAdapter();
  adapter.delayMs=0;
  const spec=exampleSpec('mock-model');
  delete spec.scenario.environment;
  spec.scenario.characters=['a','b'].map(id=>characterSchema.parse({id,name:id,identity:'직원'}));
  spec.scheduledEvents=[];
  spec.variants=[{...spec.variants[0],characterPerformanceVersion:'character-performance/3',environmentMode:'off',turnPolicy:'round_robin'}];
  spec.evaluation.enabled=false; spec.maxUtterances=12;
  const engine=new Engine(store,adapter,'.cache/history-test-speech-units');
  let recovered='';
  const turn=adapter.turn.bind(adapter);
  adapter.turn=async (...args)=>{
    const result=await turn(...args);
    if (JSON.parse(args[0].input).task!=='speak') return result;
    const raw=JSON.parse(result.output);
    const sentence='창가 받침은 모서리에 있는 작은 찻잔도 안정적으로 놓을 수 있으니, 저는 그쪽에 두는 게 마음이 좀 더 놓이겠어요.';
    const units=Array.isArray(raw.speech);
    result.output=JSON.stringify({...raw,speech:units ? [sentence] : sentence});
    adapter.results.set(result.turnId,result);
    if (units && !recovered) {
      recovered=result.turnId;
      return {...result,status:'uncertain',error:'simulated lost acknowledgement'};
    }
    return result;
  };
  try {
    const {runs:[run]}=await engine.create(spec);
    await engine.idle();
    assert.ok(recovered);
    assert.equal(engine.run(run.id).status,'paused');
    await engine.resume(run.id); await engine.idle();
    assert.equal(engine.run(run.id).status,'completed');
    const call=store.list('invocations',run.id).find(c=>c.turnId===recovered)!;
    assert.equal(call.metadata.reconciled,true);
    assert.equal(store.attempts(run.id,call.operationKey).length,1);
    const [spoken]=JSON.parse(call.output).speech;
    const lines=store.list('utterances',run.id).filter(u=>u.invocationId===call.id);
    assert.equal(lines.length,1);
    assert.equal(lines[0].speech,spoken);
    const delivered=store.list('receipts',run.id).filter(r=>r.utteranceId===lines[0].id);
    assert.equal(delivered.length,1);
    assert.equal(delivered[0].status,'delivered');
  } finally {await engine.close();store.close();}
});
