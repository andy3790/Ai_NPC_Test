import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockAdapter } from '../src/adapters/mock.js';
import { Store } from '../src/core/store.js';
import { Engine } from '../src/core/engine.js';
import { compactDiscussion, conversationMemory, TOPIC_CLOSURE_VERSION } from '../src/core/conversation-memory.js';
import { authoredObservation, SCENE_OBSERVATION_VERSION } from '../src/core/scene-observation.js';
import { receiverPrompt, speakerPrompt } from '../src/core/prompts.js';
import { exampleSpec } from '../src/shared/example.js';
import type { Utterance } from '../src/shared/types.js';

function line(n:number,speaker:string,speech:string): Utterance {
  return {id:'u'+n,runId:'example',sequence:n,speechIndex:n,speakerId:speaker,speakerName:speaker,
    kind:'speech',speech,action:'',createdAt:'',invocationId:null,deliveryCompletedAt:null,deliveryMs:null};
}
const policies={topicClosureVersion:TOPIC_CLOSURE_VERSION,sceneObservationVersion:SCENE_OBSERVATION_VERSION};

test('recurrence preserves individual positions, fresh evidence, and private dissent', () => {
  const history=[line(1,'가','천막은 내가 쓸게.'),line(2,'나','천막은 내 차례야.'),
    line(3,'가','천막은 내가 쓸게.'),line(4,'나','천막을 먼저 쓰기로 약속했잖아.'),
    line(5,'가','천막을 빌려주면 내가 손해를 봐.'),line(6,'나','천막에서 첫 손님을 받기로 했어.'),
    line(7,'가','천막에 지금 들어가지 마.')];
  const privateLine={...line(8,'다','누구에게도 전하지 않은 천막 얘기'),perception:{
    virtualSeconds:2,locationId:'another',speechRecipientIds:[],actionRecipientIds:[]}};
  const memory=conversationMemory([...history,privateLine],'나',[1],new Set(['u7']),'conversation-memory/4','천막에서 내 책을 펼치고 싶다.',false,policies);
  assert.deepEqual(memory.context.repeatedExchange?.recentVoices?.map(v=>v.sequence),[6,7]);
  assert.ok(memory.omit.has(1) && ![2,4,5,6,7].some(n=>memory.omit.has(n)));
  assert.deepEqual(memory.context.pendingChoice?.otherWords.quote,history[6].speech);
  assert.equal(memory.context.pendingChoice?.ownWords?.sequence,6);
  assert.equal(memory.context.pendingChoice?.ownInterest,'천막에서 내 책을 펼치고 싶다.');
  const packed=compactDiscussion(memory.context,[7]);
  assert.equal(packed.pendingChoice?.otherWords.sequence,7);
  assert.ok(!('quote' in packed.pendingChoice!.otherWords));
  assert.equal(JSON.stringify(packed).split(history[5].speech).length-1,1);
  assert.ok(!JSON.stringify(packed).includes(history[6].speech));
  assert.doesNotMatch(JSON.stringify(memory.context),/이미 서로 넘긴|누구에게도/);
  const dessert=conversationMemory([line(1,'나','오늘 날씨 좋다.'),line(2,'가','케이크는 내가 먼저 먹어볼게.')],'나',[],new Set(['u2']),'conversation-memory/4','천막에서 장사한다.',false,policies);
  assert.equal(dessert.context.pendingChoice,undefined);
});

test('a quoted request stays in the observation, while the world source and adjudication stay private', () => {
  const message='인터폰에서 “불을 올려 주세요”라는 목소리가 들린다.';
  assert.equal(authoredObservation('[ORC-E03 / 운영 메모] 전체에게 대답을 요청',message),message);
  assert.equal(authoredObservation('[ORC-E03 / 한도] '+message),message);
  assert.equal(authoredObservation('[방송] '+message),'[방송] '+message);
  const u:Utterance={...line(1,'__environment__',message),speakerName:'세계 엔진',kind:'event',speechIndex:null,
    worldEvent:{type:'observation',text:message,evidence:'privately known rationale',npcId:null,processId:null,sourceUtteranceId:null,virtualSeconds:4}};
  for (const packet of [JSON.parse(receiverPrompt(u,'가',true)).message,JSON.parse(speakerPrompt([u],undefined,undefined,'가',undefined,true)).messages[0]]) {
    assert.deepEqual(packet,{id:'u1',sequence:1,kind:'event',observation:message,virtualSeconds:4});
  }
  assert.equal(JSON.parse(receiverPrompt(u,'가')).message.speakerName,'세계 엔진');
});

test('only a listener who set the topic aside gets shorter recall, and a question or observation reopens it', () => {
  const history=Array.from({length:8},(_,i)=>line(i+1,i%2?'나':'가',
    ['레몬 향이 좋네.','레몬 향이 진하네.','레몬 향은 나도 좋았어.','레몬 향이 남네.'][i%4]));
  const memory=(rows:Utterance[],stored:number[])=>conversationMemory(rows,'가',stored,new Set([rows.at(-1)!.id]),
    'conversation-memory/4','',false,policies);
  const closed=memory(history,[2]);
  assert.equal(closed.quiet,true);
  assert.ok(closed.context.quiet);
  assert.equal(closed.context.repeatedExchange,undefined);
  assert.ok(closed.omit.has(3) && !closed.omit.has(8));
  assert.ok(memory(history,[]).context.repeatedExchange);
  for (const fresh of [line(9,'나','레몬 향을 어디서 맡았어?'),line(9,'나','레몬 향은 내 차례야.'),
    {...line(9,'__narrator__','창문이 열린다.'),kind:'event' as const}]) {
    assert.ok(memory([...history,fresh],[2]).context.repeatedExchange);
  }
  const later=Array.from({length:24},(_,i)=>line(i+1,i%2?'나':'가','레몬 그림에 물방울이 남았네.'));
  assert.equal(memory(later,[2]).quiet,true);
  assert.equal(memory([...later,line(25,'나','다음 주부터 일하러 지방에 가.')],[2]).quiet,false);
});

for (const deliveryMode of ['batched_on_turn','per_utterance'] as const) {
  test('manual and scheduled observations follow the same audience and history path: '+deliveryMode,async()=>{
    const store=new Store(':memory:'), adapter=new MockAdapter();
    adapter.name='openai'; adapter.delayMs=0;
    const engine=new Engine(store,adapter,'.cache/history-test-actor-observations');
    try {
      const spec=exampleSpec('mock-model');
      delete spec.scenario.environment;
      spec.scenario.characters=spec.scenario.characters.slice(0,2);
      const [one,two]=spec.scenario.characters;
      const audience={scope:'npcs' as const,npcIds:[two.id],locationIds:[]};
      spec.variants=[{...spec.variants[0],environmentMode:'off',turnPolicy:'round_robin',deliveryMode}];
      spec.scheduledEvents=[{afterUtterance:0,text:'편집자 전용 예정 메모',observation:'파란 불빛이 깜박인다.',audience}];
      spec.maxUtterances=4; spec.evaluation.enabled=false;
      const {runs:[run]}=await engine.create(spec,false);
      await engine.inject(run.id,'편집자 전용 즉석 메모',audience,'문밖에서 종소리가 난다.');
      await engine.resume(run.id);await engine.idle();
      const detail=engine.detail(run.id);
      assert.equal(detail.run.status,'completed',detail.run.error ?? undefined);
      const events=detail.utterances.filter(u=>u.kind==='event');
      assert.deepEqual(events.map(e=>e.speech),['문밖에서 종소리가 난다.','파란 불빛이 깜박인다.']);
      const actors=detail.invocations.filter(c=>c.kind==='receive' || c.kind==='speech');
      assert.ok(actors.every(c=>!c.input.includes('편집자 전용') && !c.input.includes('__narrator__')));
      assert.ok(actors.filter(c=>c.characterId===one.id).every(c=>!c.input.includes('종소리') && !c.input.includes('파란 불빛')));
      const observed=actors.filter(c=>c.characterId===two.id).flatMap(c=>{
        const p=JSON.parse(c.input);return [...(p.messages ?? []),...(p.message ? [p.message] : [])];
      }).filter(m=>m.kind==='event');
      assert.deepEqual(observed.map(m=>m.observation),events.map(e=>e.speech));
      assert.ok(observed.every(m=>!('speech' in m || 'speakerName' in m)));
      const recalled=actors.flatMap(c=>JSON.parse(c.input).earlierObservations ?? []).filter(m=>m.kind==='event');
      assert.ok(recalled.some(m=>m.observation===events[1].speech && !('speaker' in m)));
      assert.equal(store.events(run.id).filter(e=>e.method==='narrator/event' && JSON.stringify(e.params).includes('편집자 전용')).length,2);
    } finally {await engine.close();store.close();}
  });
}
