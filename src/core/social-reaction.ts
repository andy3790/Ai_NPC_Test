import { z } from 'zod';
import type { Character } from '../shared/schema.js';
import type { Run, SocialMemory, Utterance } from '../shared/types.js';
import { receives, visibleUtterance } from './perception.js';
import { languageRepairSchema } from './actor-context.js';

export const SOCIAL_REACTION_VERSION = 'social-reaction/3' as const;
const stances = ['발끈함', '시비를 검', '대화를 끊음', '풀어 둠'] as const;
const decisionSchema = z.object({peerId:z.string(), stance:z.enum(stances)}).strict().nullable();

// These cues open a private choice. They do not assign an emotion, change
// anyone else's disposition, or classify people by identity or occupation.
const temperament = /거만|오만|허세|건방|시비|양아치|불량배|다혈질|욱하|욱한|버럭|성질.{0,5}(?:급|더럽)|콧대|자존심|체면|만만|깔보|비아냥|빈정|뒤끝|명령받|지시받|무시당|정이\s*떨/u;
const socialCue = /비웃|비아냥|빈정|발끈|호통|버럭|언성|소리(?:를)?\s*질|피식|코웃음|명령|시비|짜증|깔보|뭘\s*봐|뭐\s*봐|뭘?\s*웃|네가\s*뭔데|누가\s*너|말투|시키지|꺼져|닥쳐|집어치워|치우라고|치워|네가\s*해|니가\s*해|그만\s*(?:해|하라)|[가-힣]+(?:해라|하라고)/u;
const instruction = '부탁의 내용과 그 사람이 내게 하는 꼴은 다르게 받아들일 수 있다. 성격에 따라 흘려듣거나 그냥 해 줘도 된다. 아니꼬우면 일이 사소해도 먼저 트집을 잡거나, 언성을 높이거나, 내게 손해여도 하던 일을 깨고 대꾸를 끊을 수 있다. 실제로 하고 싶은 말과 행동만 한다. 상대의 의도를 확인하거나 속상한 이유를 잘 설명해야 할 의무는 없다. socialChoice는 지금 내가 그 사람을 대하는 태도를 바꾸기로 한 경우에만 고른다. 평소대로이거나 이미 하던 태도를 이어 가면 null이다. 풀렸을 때는 내가 풀어 둠을 고를 수 있다.';

const directOrder = /(?:치워|집어넣어|내놔|갖다\s*놔|가져와|하지\s*마|이리\s*와|비켜|조용히\s*해|네가\s*해|그만\s*해|[가-힣]+(?:해라|하라고|부터\s*해))(?:[.!?\s”」"]|$)/u;
const perceivedSlight = /피식|비웃|코웃음|키득|낄낄|말투|네가\s*뭔데|깝치|뭘?\s*웃|잘난\s*척|만만|신경\s*꺼|우스워/u;
const sensitivity = /거만|오만|지시받|명령받|누가.{0,8}시키|다혈질|욱하|버럭|자존심.{0,6}(?:세|강|상)/u;
const picksFights = /먼저\s*시비|시비.{0,10}(?:거는|건다|걸곤|잘\s*걸)|양아치|다혈질|불량배|걸핏하면|툭하면.{0,8}(?:성질|화|트집)/u;
const disavowedTrait = /시비.{0,10}(?:거는\s*(?:사람|애)|걸지\s*않|걸지\s*못)|(?:시비|다툼|싸움).{0,7}(?:싫어|피한)|(?:거만|오만)(?:하지\s*않|한\s*사람)/u;
const privateBeat = '지금 막 걸린 한 대목에 대한 첫 반응이다. 자존심이 먼저라면 실제 말이나 선택에서도 그쪽으로 가라. 상대를 좋게 타이르거나 공평하게 양쪽 이유를 대줄 필요는 없다. 이 말을 뱉어 놓고 같은 숨에 부탁까지 들어주거나 공동 계획을 재개하는 두 장면을 한 차례로 접지 않는다. 넘기는 쪽이 이 사람답다면 그대로 넘긴다.';
const affront = '시키는 말 한마디가 이 사람한테는 서열을 매기는 것처럼 거슬릴 수 있다. 일의 시시비비를 따질 새 없이 상대에게 말이 먼저 튀어나오는 순간이다.';
const provocation = '자기 앞에서 웃거나 빈정댄 사람에게 괜히 시비를 걸고 싶은 순간이다. 물건을 상대로 농담하는 것과 눈앞의 사람한테 쏘아붙이는 것은 다른 선택이다. 억울하게 몰아붙여도 상대가 실제로 그런 속셈이었다는 뜻은 아니다.';
const nextExchange = '방금 그 사람에게 쏘아붙인 뒤의 일이다. 상대의 해명이나 사과를 듣고도 기분이 더 상할 수 있다. 이 일을 계속 같이 할지, 엎고 가 버릴지, 그냥 넘길지는 지금 내가 고른다.';

// Only bind a character to words they actually spoke or a named, observed
// act. A sign containing an imperative cannot put another NPC in this role.
function attributable(text:string, peers:{id:string;name:string}[]) {
  for (const part of text.split(/(?<=[.!?。])\s+(?![“「"])|\n/u).reverse()) {
    const subjects=peers.filter(p=>part.includes(p.name+'이') || part.includes(p.name+'가') ||
      part.includes(p.name+'은') || part.includes(p.name+'는'));
    if (subjects.length===1 && (perceivedSlight.test(part) || /[“「"]/.test(part) && /말한다|묻는다|외친다|소리친다|목소리/u.test(part)))
      return {peerId:subjects[0].id,text:part};
  }
}

// An observer can hear a local utterance addressed to somebody else. Only
// treat an order as personal if its explicit addressee fits this observer.
function orderedElsewhere(text: string, actor: string, speaker: string, cast: Character[]) {
  return cast.some(c => c.id!==actor && c.id!==speaker &&
    [c.name+'에게', c.name+'한테', c.name+'아,', c.name+'야,'].some(address => text.includes(address)));
}

export function socialTurn(character: Character, cast: Character[], history: Utterance[], memory: SocialMemory[],
    nearby?: {id:string}[], version:Run['socialReactionVersion']=SOCIAL_REACTION_VERSION, opening='') {
  const actor=character.id;
  const last=history.findLast(u=>u.kind==='speech' && u.speakerId===actor);
  const seen=history.filter(u=>u.sequence>(last?.sequence ?? 0) && u.speakerId!==actor && receives(u,actor))
    .map(u=>{
      const targets=u.spatialIntent?.communication.targetNpcIds;
      return {...visibleUtterance(u,actor),addressedElsewhere:!!targets?.length && !targets.includes(actor)};
    }).filter(u=>u.speech.trim() || u.action.trim());
  const heard=new Set(seen.filter(u=>u.kind==='speech' && u.speech.trim()).map(u=>u.speakerId));
  const peers=cast.filter(c=>c.id!==actor && (!nearby || nearby.some(n=>n.id===c.id) || heard.has(c.id)));
  if (!peers.length || (last && !seen.length)) return;
  const prior=memory.filter(m=>peers.some(c=>c.id===m.peerId));
  const personal=version==='social-reaction/3';
  const ownProfile=personal ? [character.personality,character.behaviors,character.speechStyle] :
    [character.personality,character.values,character.relationships,character.speechStyle,character.behaviors];
  const touchy=ownProfile.find(line=>temperament.test(line) && !(personal && disavowedTrait.test(line)));
  // A document or an operator note is not an interpersonal act. A quoted
  // request remains an authentic part of what the character heard in a scene.
  const pressure=seen.some(u=>u.kind==='speech' ? socialCue.test(u.speech+' '+u.action) : personal
    ? socialCue.test(attributable(u.speech,peers)?.text ?? '')
    : (u.speech.match(/[“「"]([^”」"\n]+)[”」"]/gu) ?? []).some(quote=>socialCue.test(quote)));
  let stimulus:{peerId:string;text:string}|undefined;
  if (version!=='social-reaction/1' && touchy) {
    for (const u of seen.slice().reverse()) {
      const candidate=u.kind==='speech' ? {peerId:u.speakerId,text:[u.speech,u.action].join(' ')} : attributable(u.speech,peers);
      if (candidate && peers.some(p=>p.id===candidate.peerId) && (directOrder.test(candidate.text) || perceivedSlight.test(candidate.text))) {
        if (personal && directOrder.test(candidate.text) &&
            (u.addressedElsewhere || orderedElsewhere(candidate.text,actor,candidate.peerId,cast))) continue;
        stimulus=candidate;break;
      }
    }
    if (!stimulus && !last && !nearby) {
      const stated=attributable(opening,peers);
      if (stated && !(personal && directOrder.test(stated.text) && orderedElsewhere(stated.text,actor,stated.peerId,cast))) stimulus=stated;
    }
  }
  const addressed=stimulus && touchy && directOrder.test(stimulus.text) && sensitivity.test(touchy);
  const slighted=stimulus && touchy && perceivedSlight.test(stimulus.text) && picksFights.test(touchy);
  let beat=stimulus && (addressed || slighted) ? {peerId:stimulus.peerId,observed:stimulus.text.trim().slice(0,200),
    impulse:version==='social-reaction/2' ? privateBeat : slighted ? provocation : affront} : undefined;
  if (personal && !beat && prior.length) {
    const previousOwn=last && history.findLast(u=>u.sequence<last.sequence && u.kind==='speech' && u.speakerId===actor);
    const recentPeers=new Set(prior.filter(m=>m.stance!=='대화를 끊음' && m.sequence>=(previousOwn?.sequence ?? 0)).map(m=>m.peerId));
    const answer=seen.findLast(u=>u.kind==='speech' && !u.addressedElsewhere && u.speech.trim() && recentPeers.has(u.speakerId));
    if (answer) beat={peerId:answer.speakerId,observed:answer.speech.slice(0,200),impulse:nextExchange};
  }
  if (!prior.length && !pressure && !(touchy && (!last || heard.size)) && !beat) return;
  return {peers:peers.map(c=>({id:c.id,name:c.name})), ...(touchy && {myProfile:touchy.slice(0,220)}),
    ...(beat && {beat}),
    ...(prior.length && {myEarlierChoices:prior.map(m=>({peerId:m.peerId,stance:m.stance,sequence:m.sequence}))}), instruction};
}

export function withSocialChoice(schema:{properties?:object;required?:string[]}, peers:string[]) {
  const socialChoice={anyOf:[{type:'null'}, {type:'object',additionalProperties:false,required:['peerId','stance'],
    properties:{peerId:{type:'string',enum:peers},stance:{type:'string',enum:stances}}}],
    description:'내가 고른 대인 반응. 대화를 끊음은 지금 그 사람과 이 대화를 그만하는 선택이다. 단순한 거절이나 한 번 말을 아끼는 것으로 고르지 않는다.'};
  return {...schema,properties:{socialChoice,...schema.properties},required:['socialChoice',...(schema.required ?? [])]};
}

type SpeakerSchema={properties?:object;required?:string[]};
// A momentary impulse takes one beat: the actor may speak, act, or do
// neither. Subsequent turns retain the usual simultaneous speech and action.
export function withReactionBeat(schema:SpeakerSchema) {
  const {speech:_speech,action:_action,...remaining}=schema.properties as Record<string,unknown>;
  const text={type:'string'}, silent={type:'string',enum:['']};
  const option=(speech:object,action:object)=>({type:'object',additionalProperties:false,required:['speech','action'],properties:{speech,action}});
  return {...schema,properties:{...remaining,reaction:{anyOf:[option(text,silent),option(silent,text)]}},
    required:[...(schema.required ?? []).filter(k=>k!=='speech' && k!=='action'),'reaction']};
}

export function repairReactionLanguage(schema: SpeakerSchema, context:string, error?:string|null) {
  const {reaction}=(schema.properties ?? {}) as {reaction?:{anyOf:SpeakerSchema[]}};
  if (!reaction?.anyOf.length) return;
  const options=reaction.anyOf.map(branch=>languageRepairSchema(branch,context,error));
  if (options.every(branch=>branch!==undefined))
    return {...schema,properties:{...schema.properties,reaction:{...reaction,anyOf:options}}};
}

const beatSchema=z.object({speech:z.string(),action:z.string()}).strict()
  .refine(v=>!v.speech.trim() || !v.action.trim(),'첫 반응에는 한 가지 말이나 행동을 고릅니다.');
export function spokenReaction(result:Record<string,unknown>) {
  const {reaction,...rest}=result;
  return {...rest,...beatSchema.parse(reaction)};
}

export function readSocialChoice(raw:unknown, peers: string[]) {
  const decision=decisionSchema.parse(raw);
  if (decision && !peers.includes(decision.peerId)) throw Error('관찰 가능한 상대만 대인 반응의 대상으로 고를 수 있습니다.');
  return decision;
}

export function rememberSocialChoice(prior:SocialMemory[], decision:ReturnType<typeof readSocialChoice>, sequence:number,
    version:Run['socialReactionVersion']=SOCIAL_REACTION_VERSION) {
  if (!decision) return prior;
  const existing=prior.find(m=>m.peerId===decision.peerId);
  if (existing && existing.sequence>=sequence) return prior;
  if (version==='social-reaction/3' && existing?.stance===decision.stance && decision.stance!=='대화를 끊음') return prior;
  if (decision.stance==='풀어 둠' && !existing) return prior;
  const rest=prior.filter(m=>m.peerId!==decision.peerId);
  return decision.stance==='풀어 둠' ? rest : [...rest,{peerId:decision.peerId,stance:decision.stance,sequence}];
}
