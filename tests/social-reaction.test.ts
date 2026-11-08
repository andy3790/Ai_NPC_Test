import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { MockAdapter } from '../src/adapters/mock.js';
import { dialogueEnding } from '../src/core/dialogue-idle.js';
import { Engine } from '../src/core/engine.js';
import { readSocialChoice, rememberSocialChoice, repairReactionLanguage, socialTurn, spokenReaction, withReactionBeat } from '../src/core/social-reaction.js';
import { Store } from '../src/core/store.js';
import { exampleSpec } from '../src/shared/example.js';
import { characterSchema, outputSchemas } from '../src/shared/schema.js';
import { spatialSpeechSchema } from '../src/shared/spatial-schema.js';
import type { Run, Utterance } from '../src/shared/types.js';

const cast=['가','나','다'].map((name,i)=>characterSchema.parse({id:'npc'+i,name}));
const [one,two,three]=cast;
function line(sequence:number, speakerId:string, speech:string, action=''):Utterance {
  return {id:'u'+sequence,runId:'test',sequence,speechIndex:sequence,speakerId,speakerName:speakerId,kind:'speech',
    speech,action,createdAt:'',invocationId:null,deliveryCompletedAt:null,deliveryMs:null};
}

test('a profile can initiate friction, an observation never supplies private motives or another peer’s unseen words',()=>{
  const rough={...one,personality:'거만하고 남에게 지시받기 싫다.'};
  assert.ok(socialTurn(rough,cast,[],[],[{id:two.id}]));
  assert.equal(socialTurn(one,cast,[],[],[{id:two.id}]),undefined);
  assert.equal(socialTurn(rough,cast,[],[],[]),undefined);
  const whisper={...line(1,two.id,'네가 뭔데? 저리 가.','의자에 앉는다.'),
    perception:{virtualSeconds:1,locationId:'hall',speechRecipientIds:[three.id],actionRecipientIds:[one.id]}};
  assert.equal(socialTurn(one,cast,[whisper],[],[{id:two.id}]),undefined);
  const remote=socialTurn(three,cast,[whisper],[],[]);
  assert.deepEqual(remote?.peers,[{id:two.id,name:two.name}]);
  const prior=rememberSocialChoice([],{peerId:two.id,stance:'발끈함'},2);
  const fresh=line(3,three.id,'의자 다 썼어.');
  assert.equal(socialTurn(one,cast,[line(2,one.id,'응.'),fresh],prior,[{id:three.id}]),undefined);
  assert.deepEqual(socialTurn(one,cast,[fresh],prior,[{id:two.id}])?.myEarlierChoices,prior);
  assert.throws(()=>readSocialChoice({peerId:three.id,stance:'시비를 검'},[two.id]));
  assert.throws(()=>readSocialChoice({peerId:two.id,stance:'상대도 화냄'},[two.id]));
  assert.equal(rememberSocialChoice(prior,null,3),prior);
  assert.deepEqual(rememberSocialChoice(prior,{peerId:two.id,stance:'풀어 둠'},3),[]);
});

test('one immediate choice requires both a personal cue and an observed provocation, with old and ordinary formats preserved',()=>{
  const rough={...one,personality:'거만하고 남이 지시하는 걸 싫어한다.'};
  const notice={...line(1,'__narrator__','게시판에 “네 컵 좀 치워.”라고 적혀 있다.'),kind:'event' as const};
  assert.equal(socialTurn(rough,cast,[notice],[])?.beat,undefined);
  const order={...notice,speech:two.name+'가 말한다. “네 컵 좀 치워.”'};
  assert.equal(socialTurn(rough,cast,[order],[])?.beat?.peerId,two.id);
  const indirect={...order,speech:two.name+'가 '+three.name+'에게 말한다. “네 컵 좀 치워.”'};
  assert.equal(socialTurn(rough,cast,[indirect],[])?.beat,undefined);
  const localOrder={...line(1,two.id,'네 컵 좀 치워.'),spatialIntent:spatialSpeechSchema.parse({
    speech:'네 컵 좀 치워.',action:'',communication:{mode:'local',channelId:null,targetNpcIds:[three.id]},moveToLocationId:null,activityChoice:'continue',
  })};
  assert.equal(socialTurn(rough,cast,[localOrder],[])?.beat,undefined);
  assert.equal(socialTurn(rough,cast,[order],[],undefined,'social-reaction/1')?.beat,undefined);
  assert.equal(socialTurn(one,cast,[order],[])?.beat,undefined);
  const bully={...one,personality:'먼저 시비를 잘 건다.'};
  const opening=two.name+'가 동전 떨어지는 소리에 피식 웃었다.';
  assert.equal(socialTurn(bully,cast,[],[],undefined,'social-reaction/2',opening)?.beat?.peerId,two.id);
  assert.equal(socialTurn(bully,cast,[],[],[{id:three.id}],'social-reaction/2',opening)?.beat,undefined);
  assert.deepEqual(spokenReaction({reaction:{speech:'네가 뭔데.',action:''},socialChoice:null}),{speech:'네가 뭔데.',action:'',socialChoice:null});
  assert.throws(()=>spokenReaction({reaction:{speech:'응.',action:'동전을 넣는다.'}}));
});

test('Korean language repair preserves both first-reaction choices and allows silence',()=>{
  const schema=withReactionBeat(outputSchemas.speech);
  const failure='장면과 인물에게 없는 가나 단어가 섞였습니다. 관찰한 뜻을 한국어로 자연스럽게 다시 표현하세요.';
  const result=repairReactionLanguage(schema,'한국어 장면',failure)!;
  const repaired=z.fromJSONSchema(result);
  for (const [speech,action,allowed] of [['응.','',true],['','등을 돌린다.',true],['','',true],['퇴근します','',false],['','彼は 돌아본다で.',false],['응.','일어선다.',false]] as const)
    assert.equal(repaired.safeParse({reaction:{speech,action}}).success,allowed);
  assert.equal(repairReactionLanguage(schema,'책 제목에 マッテ가 적혔다.',failure),undefined);
});

test('an ordinary answer can prolong a personal slight for two choices, without borrowing another person’s temper',()=>{
  const decision={peerId:two.id,stance:'시비를 검' as const};
  const memory=rememberSocialChoice([],decision,1);
  const history=[line(1,one.id,'너 웃었냐?'),line(2,two.id,'이름표 얘기였어.')];
  assert.equal(socialTurn(one,cast,history,memory)?.beat?.peerId,two.id);
  assert.equal(socialTurn(one,cast,history,memory,undefined,'social-reaction/2')?.beat,undefined);
  assert.equal(socialTurn(one,cast,[history[0],line(2,three.id,'응.')],memory)?.beat,undefined);
  assert.equal(rememberSocialChoice(memory,decision,3),memory);
  history.push(line(3,one.id,'됐어.'),line(4,two.id,'그래.'),line(5,one.id,'가자.'),line(6,two.id,'응.'));
  assert.equal(socialTurn(one,cast,history,memory)?.beat,undefined);
  const opening=two.name+'가 피식 웃었다.';
  for (const profile of [{relationships:'옆집 친구는 먼저 시비를 건다.'},{personality:'시비 거는 사람을 싫어한다.'}])
    assert.equal(socialTurn({...one,...profile},cast,[],[],undefined,'social-reaction/3',opening),undefined);
  const notice={...line(1,'__narrator__','벽에는 “네 컵 좀 치워.”라고 적혀 있다.'),kind:'event' as const};
  assert.equal(socialTurn(one,cast,[notice],[]),undefined);
});

test('only an opted-in two-person dialogue ends after the remaining participant has a chance to respond',async()=>{
  const store=new Store(':memory:'),adapter=new MockAdapter();
  const engine=new Engine(store,adapter,'.cache/social-reaction-test');
  try {
    const spec=exampleSpec('mock-model');
    delete spec.scenario.environment;
    spec.scenario.characters=cast.slice(0,2);
    spec.variants=[{...spec.variants[0],environmentMode:'off',stopOnSilence:true}];
    spec.scheduledEvents=[];
    const {runs:[snapshot]}=await engine.create(spec,false);
    const run:Run={...snapshot,sessions:{[one.id]:{id:'test',threadId:'test',characterId:one.id,config:spec.scenario.defaults,instructions:'',
      socialMemory:[{peerId:two.id,stance:'대화를 끊음',sequence:1}]}}};
    const first=line(1,one.id,'너 혼자 해. 난 간다.');
    const last=line(2,two.id,'야, 잠깐만.');
    assert.equal(dialogueEnding(run,[first]),undefined);
    assert.equal(dialogueEnding(run,[first,last]),'conversation_withdrawn');
    assert.equal(dialogueEnding({...run,socialReactionVersion:undefined},[first,last]),undefined);
    assert.equal(dialogueEnding({...run,variant:{...run.variant,stopOnSilence:false}},[first,last]),undefined);
    assert.equal(dialogueEnding({...run,variant:{...run.variant,environmentMode:'ai'}},[first,last]),undefined);
    assert.equal(dialogueEnding({...run,spec:{...spec,scheduledEvents:[{afterUtterance:3,text:'인터폰이 울린다.'}]}},[first,last]),undefined);
    const event={...line(2,'__narrator__','인터폰이 울린다.'),kind:'event' as const};
    assert.equal(dialogueEnding(run,[first,event,{...last,sequence:3}]),undefined);
    assert.equal(dialogueEnding({...run,spec:{...spec,scenario:{...spec.scenario,characters:cast}}},[first,last]),undefined);
  } finally {await engine.close();store.close();}
});

for (const deliveryMode of ['per_utterance','batched_on_turn'] as const) {
  test('a private decision survives lost acknowledgement without becoming a public message · '+deliveryMode,async()=>{
    const store=new Store(':memory:'),adapter=new MockAdapter();
    adapter.delayMs=0;
    const turn=adapter.turn.bind(adapter);
    let first=true;
    adapter.turn=async(...args)=>{
      const result=await turn(...args);
      if (JSON.parse(args[0].input).task!=='speak') return result;
      const out=JSON.parse(result.output);
      const isFirst=first;
      result.output=JSON.stringify({...out,speech:isFirst?'너 혼자 해. 난 간다.':'그게 그렇게 말할 일이야?',action:'',
        ...(isFirst && {socialChoice:{peerId:two.id,stance:'대화를 끊음'}})});
      adapter.results.set(result.turnId,result);
      if (first) {first=false;return {...result,status:'uncertain',error:'simulated lost acknowledgement'};}
      return result;
    };
    const spec=exampleSpec('mock-model');delete spec.scenario.environment;
    spec.scenario.characters=[{...one,personality:'사소한 걸로 시비를 잘 건다.'},two];
    spec.variants=[{...spec.variants[0],environmentMode:'off',turnPolicy:'round_robin',stopOnSilence:true,deliveryMode}];
    spec.scheduledEvents=[];spec.evaluation.enabled=false;spec.maxUtterances=12;
    const engine=new Engine(store,adapter,'.cache/social-reaction-test');
    try {
      const {runs:[run]}=await engine.create(spec);await engine.idle();
      assert.equal(engine.run(run.id).status,'paused');
      assert.equal(engine.run(run.id).sessions[one.id].socialMemory,undefined);
      await engine.resume(run.id);await engine.idle();
      const d=engine.detail(run.id);
      assert.equal(d.run.completionReason,'conversation_withdrawn',d.run.error ?? undefined);
      assert.deepEqual(d.run.sessions[one.id].socialMemory,[{peerId:two.id,stance:'대화를 끊음',sequence:1}]);
      assert.equal(d.run.sessions[two.id].socialMemory,undefined);
      assert.deepEqual(d.utterances.map(u=>u.speakerId),[one.id,two.id]);
      assert.equal(store.attempts(run.id,'speech:1').length,1);
      assert.ok(d.utterances.every(u=>!('socialChoice' in u) && !('socialMemory' in u)));
      const others=d.invocations.filter(c=>c.characterId===two.id);
      assert.ok(others.every(c=>!c.input.includes('사소한 걸로 시비를 잘 건다.') && !c.input.includes('myEarlierChoices')));
    } finally {await engine.close();store.close();}
  });
}
