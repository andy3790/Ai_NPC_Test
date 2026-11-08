import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { NpcSession, Run, Utterance } from '../shared/types.js';
import { elapsedCaption } from '../shared/scene-time.js';
import { receives, visibleUtterance } from './perception.js';

export const SCENE_FLOW_VERSION = 'scene-flow/3' as const;
export const usesSceneFlowV2 = (version:Run['sceneFlowVersion']) => version==='scene-flow/2' || version==='scene-flow/3';
export const sceneTime = (run: Run) => run.worldState?.virtualSeconds ?? run.sceneSeconds ?? 0;
const rests = [0, 30, 120, 300, 900] as const;
type SpeechContract = {properties?:object; required?:string[]};
type Evidence = {sequence:number; kind:string; observation:string};

function evidence(u: Utterance): Evidence {
  const kind=u.timeCut ? '시간 경과' : u.kind==='event' ? '확인한 변화' : u.action.trim() ? '본 행동과 말' : '들은 말';
  return {sequence:u.sequence,kind,observation:(u.kind==='event' ? u.speech : u.speakerName+' · '+[u.speech,u.action].filter(Boolean).join(' / ')).slice(0,220)};
}

// Only an actor's own view can supply a reason to change their plans. One
// durable, accepted result stays available even after routine talk buries it.
export function sceneTurn(run:Run, session:NpcSession, history:Utterance[]) {
  const actor=session.characterId, time=sceneTime(run), intent=session.sceneIntent;
  let ownTurns=0,lastOwn=0;
  let result:Utterance|undefined,lastChange:Utterance|undefined,partner:Utterance|undefined,ownAct:Utterance|undefined,prior:Utterance|undefined;
  const after=intent?.sourceSequence ?? 0;
  for (const u of history) {
    if (u.kind==='speech' && u.speakerId===actor) {ownTurns++;lastOwn=u.sequence;}
    if (u.sequence<after || u.speakerId!==actor && !receives(u,actor)) continue;
    const seen=visibleUtterance(u,actor);
    if (!seen.speech.trim() && !seen.action.trim()) continue;
    if (seen.sequence===after) {prior=seen;continue;}
    if (seen.resolution || seen.worldEvent && ['actor_result','physical_effect','external_signal'].includes(seen.worldEvent.type)) result=seen;
    if (seen.kind==='event') lastChange=seen;
    if (seen.kind==='speech' && seen.speakerId!==actor && seen.speech.trim()) partner=seen;
    if (seen.speakerId===actor && seen.action.trim()) ownAct=seen;
  }
  const woke=!!session.sceneWait && time>=session.sceneWait.until;
  const opportunity=ownTurns>0 && (woke || ownTurns%3===1 || !!lastChange && lastChange.sequence>lastOwn);
  const selected=opportunity ? [result,lastChange,partner,ownAct].filter((u):u is Utterance=>!!u) : [];
  const sources=[...new Set(selected)].sort((a,b)=>a.sequence-b.sequence).map(evidence);
  const clock={elapsedSeconds:Math.floor(time), ...(session.sceneWait && {sinceMyChoiceSeconds:Math.max(0,Math.floor(time-session.sceneWait.from)),
    returnReason:woke ? '내가 기다리기로 한 시간이 지났다.' : '기다리는 중 새로 관찰할 일이 생겼다.'})};
  return {sources,context:{clock,...(prior && intent && {myIntention:intent.intention,because:evidence(prior),
    intentionUse:'이 관찰 뒤 스스로 택한 현재 관심사다. 지금 할 수 있는 일을 해도 되고 사정이 바뀌면 다시 고른다.'}),
    ...(sources.length>0 && {changes:sources,choice:'이미 해 본 일의 결과, 누가 꺼낸 말, 새로 보인 것 중 하나로 인해 이제 내게 하고 싶은 다른 일이 생겼다면 followThrough에 근거 순번과 그 다음 한 가지를 고른다. 그것을 이번 말·행동·이동으로 시작할 수 있다. 처음 맡은 일을 계속 점검하거나 매번 보고할 의무는 없다. 여전히 하던 일 또는 당장 할 일이 없으면 null.'}),
    waiting:'이 선택 뒤 한동안 쉬거나 답·결과를 기다리려면 waitSeconds에 실제로 기다릴 시간을 고른다. 0이면 바로 다음 기회에 참여한다. 가만히 지켜보거나 차례를 기다리는 동안 같은 점검과 대사를 되풀이할 필요가 없다. 다른 방은 직접 이동해야 한다.'}};
}

export function withSceneChoice(schema:SpeechContract, sources:number[]) {
  const followThrough={type:'object',additionalProperties:false,required:['sourceSequence','intention'],
    properties:{sourceSequence:{type:'integer',enum:sources},intention:{type:'string',maxLength:140,
      description:'달라진 상황에서 본인이 다음에 하고 싶은 구체적인 한 가지. 완료 선언이나 다른 인물의 결정은 제외.'}}};
  return {...schema,properties:{...schema.properties,
    ...(sources.length>0 && {followThrough:{anyOf:[{type:'null'},followThrough]}}),
    waitSeconds:{type:'integer',enum:rests,description:'이번 선택 뒤의 자발적 기다림. 가상 초.'}},
    required:[...(schema.required ?? []),...(sources.length ? ['followThrough'] : []),'waitSeconds']};
}

const intentSchema=z.object({sourceSequence:z.number().int(),intention:z.string().trim().min(1).max(140)}).strict();
export function sceneDecision(raw:Record<string,unknown>, sources: number[]) {
  const wait=raw.waitSeconds===undefined ? 0 : raw.waitSeconds;
  if (typeof wait!=='number' || !rests.some(value=>value===wait)) throw Error('기다릴 수 있는 장면 시간 중 하나를 골라야 합니다.');
  const intent=raw.followThrough==null ? undefined : intentSchema.parse(raw.followThrough);
  if (intent && !sources.includes(intent.sourceSequence)) throw Error('직접 관찰한 출처만 다음 행동의 근거로 고를 수 있습니다.');
  return {wait,intent};
}

export function applySceneDecision(session:NpcSession, decision:ReturnType<typeof sceneDecision>, u:Utterance, time:number, idleWorld=false, deadline=Infinity) {
  const quiet=idleWorld && !u.speech.trim() && !u.action.trim() && !u.actionId && !u.spatialIntent?.moveToLocationId &&
    (!u.spatialIntent || u.spatialIntent.activityChoice==='start');
  const previous=session.sceneWait;
  const priorRest=previous && time>=previous.until ? previous.until-previous.from : 0;
  const idleLimit=Number.isFinite(deadline) ? Math.max(300,deadline-time) : 300;
  const duration=decision.wait || (quiet ? Math.min(idleLimit,Math.max(15,priorRest*2)) : 0);
  if (!decision.intent && !duration && !previous) return session;
  const next={...session};
  if (decision.intent) next.sceneIntent={...decision.intent,chosenAt:u.sequence};
  if (duration) next.sceneWait={sequence:u.sequence,from:time,until:time+duration};
  else delete next.sceneWait;
  return next;
}

function wakes(u:Utterance, actor:string, name:string, resting:boolean, castSize:number) {
  if (u.timeCut || u.speakerId===actor || !receives(u,actor)) return false;
  if (u.kind==='event') {
    const event=u.worldEvent;
    if (!resting || !event) return !(event?.type==='actor_result' && event.npcId===actor);
    return !u.invocationId || event.type==='external_signal' || event.type==='physical_effect'
      || !!event.processId || !!event.proposalId || event.audience?.scope==='npcs' && event.audience.npcIds.includes(actor);
  }
  const heard=visibleUtterance(u,actor).speech.trim();
  if (!heard) return false;
  const comm=u.spatialIntent?.communication;
  if (comm?.targetNpcIds.length) return comm.targetNpcIds.includes(actor);
  const question=/[?？]/u.test(heard);
  if (resting) return heard.includes(name) || question && (u.perception ? u.perception.speechRecipientIds.length===1 : castSize===2);
  return comm?.mode==='channel' || heard.includes(name) || question;
}

export function waitingActors(run:Run, history:Utterance[]) {
  const waiting=new Map<string,number>();
  if (!run.sceneFlowVersion) return waiting;
  const time=sceneTime(run);
  for (const c of run.spec.scenario.characters) {
    const wait=run.sessions[c.id]?.sceneWait;
    if (!wait || wait.until<=time) continue;
    const resting=run.sceneFlowVersion==='scene-flow/3' ? wait.until>=wait.from+120
      : run.sceneFlowVersion==='scene-flow/2' && wait.until-wait.from>=120;
    let interrupted=false;
    for (let i=history.length-1;i>=0 && history[i].sequence>wait.sequence;i--) {
      if (wakes(history[i],c.id,c.name,resting,run.spec.scenario.characters.length)) {interrupted=true;break;}
    }
    if (!interrupted) waiting.set(c.id,wait.until);
  }
  return waiting;
}

export function timeCut(run:Run, from:number, to:number, sequence:number):Utterance {
  return {id:randomUUID(),runId:run.id,sequence,speechIndex:null,speakerId:'__clock__',speakerName:'장면 시간',kind:'event',
    speech:elapsedCaption(from,to),action:'',invocationId:null,createdAt:new Date().toISOString(),deliveryCompletedAt:null,deliveryMs:null,
    sceneSeconds:to,timeCut:{from,to}};
}
