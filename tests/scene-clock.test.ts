import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { experimentSchema } from '../src/shared/schema.js';
import { spatialSpeechSchema } from '../src/shared/spatial-schema.js';
import { initialSpatialWorld, closePassages, validateSpatialChoice, selectableGroups } from '../src/core/spatial-state.js';
import { clockObservations, nextClockBoundary } from '../src/core/scene-clock.js';
import { contactPossible, localContext, speechPerception } from '../src/core/perception.js';
import { actorRecall, checkDialogue, establishedConversation, priorDisclosures } from '../src/core/actor-context.js';
import { groundedEvents, spatialChoiceContract } from '../src/core/spatial-contract.js';
import type { Utterance } from '../src/shared/types.js';

const spec = experimentSchema.parse(JSON.parse(readFileSync('assets/seowol/experiments/drama-closing-door.json','utf8')));
const [outside,,mother,daughter] = spec.scenario.characters.map(c => c.id);
const speech = spatialSpeechSchema.parse({speech:'손 보여요?',action:'',communication:{mode:'local',targetNpcIds:[],channelId:null},moveToLocationId:null,activityChoice:'start'});

test('published map crosses only the open threshold and records the authored clock once across resume', () => {
  const w = initialSpatialWorld(spec);
  assert.ok(speechPerception(spec,w,mother,speech).speechRecipientIds.includes(outside));
  assert.equal(contactPossible(spec,w,mother,outside),true);
  assert.throws(() => speechPerception(spec,w,mother,{...speech,communication:{mode:'whisper',targetNpcIds:[outside],channelId:null}}));
  assert.equal(selectableGroups(spec,w,[]).length,1);
  assert.equal(nextClockBoundary(spec,w),8); w.virtualSeconds=8;
  assert.equal(clockObservations(spec,w,'run',0).length,1);
  const saved = structuredClone(w); assert.deepEqual(clockObservations(spec,saved,'run',1),[]);
  const position = saved.spatial!.positions.find(p => p.npcId===mother)!;
  position.locationId=null; position.transit={from:'inner_room',to:'doorway',connectionId:'to_room',activityId:'unfinished'};
  assert.equal(nextClockBoundary(spec,saved),24); saved.virtualSeconds=24; closePassages(spec,saved);
  assert.equal(position.locationId,'inner_room'); assert.deepEqual(localContext(spec,saved,mother).routes,[]);
  assert.equal(contactPossible(spec,saved,mother,outside),false);
  const radio = structuredClone(spec); radio.scenario.spatial!.channels.push({id:'test',name:'무전',description:'',memberNpcIds:[mother,outside]});
  assert.equal(contactPossible(radio,saved,mother,outside),true);
  assert.deepEqual(speechPerception(spec,saved,mother,speech).speechRecipientIds,[daughter]);
  assert.throws(() => validateSpatialChoice(spec,saved,mother,{...speech,action:'밖으로 건너 보려 한다.',moveToLocationId:'doorway'}));
  assert.equal(selectableGroups(spec,saved,[]).length,2);
  assert.equal(clockObservations(spec,saved,'run',1)[0].worldEvent!.virtualSeconds,24);
  assert.deepEqual(clockObservations(spec,saved,'run',2),[]);
});

test('bounded actor context retains only seen portions and does not duplicate fresh receipts', () => {
  const record = (n:number):Utterance => ({id:'u'+n,speakerId:'a',speakerName:'A',sequence:n,kind:'speech',speech:'PRIVATE_WORD',
    action:'공개 행동',perception:{locationId:'x',virtualSeconds:n,speechRecipientIds:['b'],actionRecipientIds:['b','c']}} as Utterance);
  const history = Array.from({length:100},(_,i) => record(i));
  const recalled = actorRecall(history,'c',new Set(['u99']));
  assert.ok(recalled.length > 0 && recalled.length <= 22);
  assert.ok(recalled.every(x => !x.speech && x.action === '공개 행동' && x.sequence !== 99));
  assert.deepEqual(actorRecall(history,'d',new Set()),[]);
  assert.deepEqual(establishedConversation(history,'c'),[]);
  assert.ok(spatialSpeechSchema.safeParse({...speech,speech:'',communication:{mode:'none',targetNpcIds:[],channelId:null}}).success);
  assert.throws(() => checkDialogue('지금 マッテ 주세요.','',history,'a','한국어 대화'));
  assert.doesNotThrow(() => checkDialogue('책 제목이 マッテ였어요.','',history,'a','책 제목 マッテ'));
});

test('an actor result binds the due speaker, exact evidence and source independently of setting', () => {
  const u={id:'due',speakerId:'a',speech:'먼저 가.',action:'손을 든다.'} as Utterance;
  const schema=groundedEvents(true,[u],['a','b']);
  const event={type:'actor_result',npcId:'a',sourceUtteranceId:'due',evidence:u.action,text:'손이 보인다.',processId:null,proposalId:null,audience:{scope:'all',locationIds:[],npcIds:[]}};
  assert.ok(schema.safeParse([event]).success);
  for (const change of [{sourceUtteranceId:'future'},{npcId:'b'},{evidence:'아직 안 한 일'}]) assert.ok(!schema.safeParse([{...event,...change}]).success);
});

test('a disclosed personal fact remains attributable after a change of topic and keeps its original listeners', () => {
  const [speaker,listener,third]=spec.scenario.characters;
  const fact='어제 수요일 도예 수업을 신청했어.';
  const history=[fact,'지금은 여기서 잠깐 기다려 보자.','옆자리에 앉아서 같이 먹으면 돼.','접시는 내가 먼저 치워 둘게.'].map((speech,i) => ({
    id:'line'+i,kind:'speech',speech,action:'',speakerId:speaker.id,sequence:i+1,
    perception:{locationId:'a',virtualSeconds:i,speechRecipientIds:[listener.id],actionRecipientIds:[third.id]},
  } as Utterance));
  const character={...speaker,goals:fact,knowledge:'',memories:''};
  assert.deepEqual(priorDisclosures(history,character,[speaker,listener,third]),[{sequence:1,said:fact,heardBy:[listener.name]}]);
  history[0].perception!.speechRecipientIds=[];
  assert.deepEqual(priorDisclosures(history,character,[speaker,listener,third]),[]);
});

test('the actual actor schema offers only reachable routes, available contacts and current activity choices', () => {
  const world = initialSpatialWorld(spec);
  const view = localContext(spec,world,mother);
  const output = {...speech,action:'문 쪽으로 한 발 옮긴다.',moveToLocationId:'doorway'};
  const open = z.fromJSONSchema(spatialChoiceContract(view,mother));
  assert.ok(open.safeParse(output).success);
  const moveOnly={...output,speech:'',action:'',communication:{mode:'none' as const,channelId:null,targetNpcIds:[]}};
  assert.ok(spatialSpeechSchema.safeParse(moveOnly).success);
  assert.doesNotThrow(() => validateSpatialChoice(spec,world,mother,moveOnly));
  assert.ok(!open.safeParse({...output,activityChoice:'continue'}).success);
  assert.ok(!open.safeParse({...output,communication:{mode:'whisper',channelId:null,targetNpcIds:[outside]}}).success);
  assert.ok(open.safeParse({...output,communication:{mode:'local',channelId:null,targetNpcIds:[outside]}}).success);
  world.virtualSeconds=24;
  const closed = localContext(spec,world,mother);
  assert.throws(() => validateSpatialChoice(spec,world,mother,moveOnly));
  closed.ongoingActivity={id:'busy',sourceUtteranceId:'own',startedAtSeconds:23,expectedEndSeconds:25,moveToLocationId:null};
  const active=z.fromJSONSchema(spatialChoiceContract(closed,mother));
  assert.ok(!active.safeParse({...output,activityChoice:'cancel'}).success);
  const continuing={...speech,activityChoice:'continue'};
  assert.ok(active.safeParse(continuing).success);
  assert.ok(!active.safeParse({...continuing,communication:{mode:'local',channelId:null,targetNpcIds:[outside]}}).success);
});
