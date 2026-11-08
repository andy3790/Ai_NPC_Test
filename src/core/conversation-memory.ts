import { receives, visibleUtterance } from './perception.js';
import type { Run, Utterance } from '../shared/types.js';

export const CONVERSATION_MEMORY_VERSION = 'conversation-memory/2' as const;
export const DIALOGUE_MEMORY_VERSION = 'conversation-memory/4' as const;
export const TOPIC_CLOSURE_VERSION = 'topic-closure/6' as const;
export const usesSourceReferences = (version: Run['topicClosureVersion']) =>
  version==='topic-closure/3' || version==='topic-closure/4' || version==='topic-closure/5' || version===TOPIC_CLOSURE_VERSION;
export const recallsPlans = (version: Run['conversationMemoryVersion']) =>
  version==='conversation-memory/3' || version===DIALOGUE_MEMORY_VERSION;

// Shared vocabulary identifies a possible loop. It cannot establish an outcome.
const common = new Set('그거 그건 그럼 그러 그래 이거 이제 지금 아까 다시 계속 먼저 한번 조금 그냥 정말 좋겠 그렇 같아 같은 있어 없네 없어요 하는 하면 보고 싶은 같다 여기 같이 잠깐 확인 정리 말해 다음'.split(' '));
function terms(text: string, extended = false) {
  const words = text.normalize('NFC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const result = new Set<string>();
  for (const word of words) {
    const stem = word.replace(/(?:으로부터|에서는|이라는|이라면|이라고|이라고는|에게서|처럼|부터|까지|에서|으로|에는|에도|이랑|하고|이나|라면|이라|은|는|이|가|을|를|와|과|에|도|만)$/u,'');
    const noun = extended && stem.length>2 ? stem.replace(/로$/u,'') : stem;
    const key = /^[가-힣]+$/u.test(noun) ? noun.slice(0,3) : noun;
    if (key.length >= 2 && !common.has(key)) result.add(key);
  }
  return result;
}
const subjectText = (u: Utterance) => u.speech.trim() ? u.speech : u.action;
const cite = (u: Utterance) => ({sequence:u.sequence, ...(u.speakerName && {speaker:u.speakerName}),
  kind:u.kind === 'event' ? '관찰' : u.speech.trim() ? '발언' : '행동', quote:subjectText(u).slice(0,175)});
type Citation = ReturnType<typeof cite>;
interface ConversationMemory {
  context: {
    quiet?: string;
    next?: string;
    checkpoint?: string;
    sources?: Citation[];
    setAside?: Citation[];
    repeatedExchange?: { turns: number; last: Citation; recentVoices?: Citation[] };
    pendingChoice?: { otherWords: Citation; ownWords?: Citation; ownInterest?: string };
    lastGoalObservation?: { attempt: string; result: Citation };
    resultUse?: string;
    prospective?: Citation;
    timeUse?: string;
  };
  quiet: boolean;
  ordinaryRecall?: boolean;
  omit: Set<number>;
  offered: number[];
}

function recurringExchange(visible: Utterance[], actor: string, extended: boolean) {
  const lines = visible.filter(u => u.kind === 'speech' && u.speech.trim()).slice(-18);
  if (lines.length < 7) return;
  const subjects = lines.map(u => terms(u.speech,extended));
  const recent = new Set(subjects.slice(-3).flatMap(s => [...s]));
  let matched: Utterance[] = [];
  for (const word of recent) {
    const candidates = lines.filter((_,i) => subjects[i].has(word));
    if (candidates.length >= 5 && candidates.length > matched.length && candidates.some(u => u.speakerId === actor) &&
        candidates.some(u => u.speakerId !== actor)) {
      matched = candidates;
    }
  }
  if (!matched.length) return;
  return matched;
}

// A person's refusal or request is evidence of that person's position. Only
// attach the listener's own earlier words or goal if they concern this subject.
const choiceCue=/지\s*(?:말자|말아|마(?:라|세요|요)?(?:[.!?\s]|$))|양보.{0,7}(?:못|어렵|할 수 없)|동의.{0,7}(?:못|않|어렵|없)|반대(?:해|야|예요|합니다)|먼저.{0,10}(?:약속했|쓰기로|내주기로)|내\s*차례(?:야|다|잖|예요|라고)|못\s*(?:내줘|비켜|넘겨|주겠)/u;
const resistsChoice=(speech:string)=>choiceCue.test(speech) || /(?:못|안)\s*물러|물러.{0,6}(?:없|않)|양보.{0,6}(?:싫|않)/u.test(speech);
function pendingChoice(visible: Utterance[], actor: string, since: number, fresh: Set<string>, goal: string) {
  const last=visible.findLast(u=>u.kind==='speech' && u.speech.trim());
  if (!last || last.speakerId===actor || (last.sequence<=since && !fresh.has(last.id))) return;
  if (!choiceCue.test(last.speech)) return;
  const subject=terms(last.speech,true);
  const related=(text:string)=>[...terms(text,true)].some(word=>subject.has(word));
  const old=visible.slice(-24).findLast(u=>u.speakerId===actor && u.kind==='speech' && related(u.speech));
  const interest=goal.split(/\r?\n/u).filter(s=>s.trim() && related(s)).at(-1);
  return {otherWords:cite(last), ...(old && {ownWords:cite(old)}), ...(interest && {ownInterest:interest.slice(0,210)})};
}

function lastGoalResult(visible: Utterance[], actor: string, goal: string) {
  const wanted = terms(goal,true);
  if (!wanted.size) return;
  const own = new Map(visible.filter(u => u.speakerId===actor && u.action.trim()).map(u => [u.id,u]));
  for (let i=visible.length-1;i>=0;i--) {
    const u=visible[i];
    if (u.worldEvent?.type!=='actor_result' || u.worldEvent.npcId!==actor || !u.speech.trim()) continue;
    const source=own.get(u.worldEvent.sourceUtteranceId ?? '');
    if (!source || ![...terms(source.action+' '+u.speech,true)].some(term => wanted.has(term))) continue;
    return {attempt:source.action.slice(0,140), result:cite(u)};
  }
}

const future = /다음\s*(?:주|달|번|에|엔)|나중에|내일|[가-힣]면.{0,65}(?:줄게|드릴게|할게|볼게|보여|싶|겠)/u;
const newScene = /(?:며칠|몇\s*(?:일|주|달)|[한두세네]\s*(?:주|달))\s*(?:후|뒤|지나)|(?:다음\s*날|이튿날|시간이\s*흘)/u;
function planTerms(text: string) {
  const words=terms(text,true);
  // A bare noun can itself end in a particle-like syllable (손잡이 / 손잡이가).
  for (const [word] of text.matchAll(/[가-힣]+/gu)) {
    if (word.length===3 && /[이가]$/u.test(word)) words.add(word);
  }
  return words;
}
function prospectOnReturn(visible: Utterance[], actor: string, fresh: Set<string>, since: number) {
  const incoming = visible.filter(u => (u.sequence>since || fresh.has(u.id)) && u.kind==='speech' && u.speakerId!==actor).slice(-3);
  if (!incoming.length) return;
  const asked = new Set(incoming.flatMap(u => [...planTerms(u.speech)]));
  let best: Utterance | undefined;
  let score = 0;
  for (const u of visible.slice(-128)) {
    if (u.kind === 'event' && (newScene.test(u.speech) || [...terms(u.speech,true)].some(w => asked.has(w)))) {
      best = undefined;
      score = 0;
    }
    if (u.speakerId!==actor || u.kind!=='speech' || fresh.has(u.id) || !future.test(u.speech)) continue;
    const shared = [...planTerms(u.speech)].filter(w=>asked.has(w));
    if (shared.length<2 && !shared.some(w=>w.length>=3)) continue;
    const weight = shared.length + (/[가-힣]면/u.test(u.speech) ? 4 : 0);
    if (weight > score) {
      best = u;
      score = weight;
    }
  }
  if (!best) return;
  const { sequence, speech } = best;
  const anchors = planTerms(speech);
  if (visible.some(u => u.sequence > sequence && [...terms(u.action,true)].filter(w => anchors.has(w)).length >= 2)) return;
  return cite(best);
}

// A narrow check for first-hand recollection of a prospective detail. Reported
// facts, questions and conditional past forms remain available to the speaker.
export function checkProspectiveClaim(speech: string, prospect: Citation | undefined, personalHistory: string) {
  if (!prospect || !/[았었였했됐졌]/u.test(speech) || !/더라(?:고요|구요|고)?[.!…\s]*$/u.test(speech) ||
      /[?？]|더라면|[았었]으면|예전에|지난번|어제/u.test(speech)) return;
  const source=planTerms(prospect.quote), known=planTerms(personalHistory);
  const recollection=speech.split(/[.!?。…]/u).map(s=>s.trim()).filter(Boolean).at(-1) ?? '';
  const shared=[...planTerms(recollection)].filter(w=>w.length>=3 && source.has(w));
  if (shared.length && !shared.some(w=>known.has(w)))
    throw Error('아직 조건부로 이야기한 일을 직접 겪은 기억으로 바꿨습니다. 확인된 시점에서 다시 답하세요.');
}

interface Disclosure { said: string; heardBy: string[] }
// A quiet broadcast has no new listener or intervening question. Match only a
// whole, previously heard past-tense statement, leaving ordinary agreement,
// changed circumstances and explicit callbacks free to pass.
export function checkQuietDisclosure(speech: string, disclosures: Disclosure[], listeners: string[]) {
  if (!listeners.length || /아까|말했|말씀드렸|얘기했|생각났|기억나|그때|바뀌|달라/u.test(speech)) return;
  const statements=(text:string)=>(text.match(/[^.!?？…。]+[.!?？…。]?/gu) ?? []).filter(s=>!/[?？]$/u.test(s))
    .map(s=>s.trim().replace(/^(?:(?:아|어|응|네|그리고|근데|참)[,，]\s*)+/u,''))
    .filter(s=>s.length>=10 && s.split(/\s+/u).length>=3 && /[았었였했왔갔됐]/u.test(s))
    .map(s=>s.normalize('NFC').replace(/[^\p{L}\p{N}]/gu,''));
  const prior=new Set(disclosures.filter(d=>listeners.every(name=>d.heardBy.includes(name))).flatMap(d=>statements(d.said)));
  if (prior.size && statements(speech).some(s=>prior.has(s)))
    throw Error('같은 사람들이 이미 들은 소식을 변화나 질문 없이 다시 알렸습니다. 지난 대화 이후 달라진 일이 있는지 확인하세요.');
}

export function conversationMemory(history: Utterance[], actor: string, stored: number[], fresh: Set<string>,
    version: Run['conversationMemoryVersion'] = CONVERSATION_MEMORY_VERSION, goal = '', pendingActivity = false,
    policies: Pick<Run,'topicClosureVersion'|'sceneObservationVersion'> = {}): ConversationMemory {
  const extended = version!=='conversation-memory/1';
  const visible = history.filter(u => u.speakerId === actor || receives(u,actor)).map(u => {
    const seen=visibleUtterance(u,actor);
    return policies.sceneObservationVersion && seen.kind==='event' ? {...seen,speakerName:''} : seen;
  })
    .filter(u => subjectText(u).trim());
  const ownChoices = history.filter(u => u.kind === 'speech' && u.speakerId === actor);
  const ownTurns = ownChoices.length;
  const last = ownChoices.at(-1);
  const rested = extended && !pendingActivity && last && !last.speech.trim() && !last.action.trim() && !last.actionId &&
    !last.spatialIntent?.moveToLocationId && !['continue','cancel'].includes(last.spatialIntent?.activityChoice ?? '') &&
    !visible.some(u => u.sequence>last.sequence || fresh.has(u.id));
  if (rested) return {context:{quiet:'지난 차례에 본인이 쉬었고 그 뒤 새로 들은 말이나 관찰이 없다. 스스로 할 새 일이 있을 때 선택하고, 그대로 쉬어도 된다.'},
    quiet:true,omit:new Set<number>(),offered:[]};
  const recent = visible.slice(-6);
  const recentTerms = new Set(recent.flatMap(u => [...terms(subjectText(u),extended)]));
  const aside = visible.filter(u => stored.includes(u.sequence));
  const relevant = aside.filter(u => [...terms(subjectText(u),extended)].filter(w => recentTerms.has(w)).length >= 2);
  const repeated = recurringExchange(visible,actor,extended);
  // Ordinary exchanges should not be rehearsed as disputes. Switch to the
  // position-preserving recall only on public evidence perceived by this actor.
  const ordinaryRecall=policies.topicClosureVersion===TOPIC_CLOSURE_VERSION &&
    !visible.filter(u=>u.kind==='speech' && u.speech.trim()).slice(-18).some(u=>
      resistsChoice(u.speech) || /(?:약속|내줄|비켜|양보|내가?\s*먼저).{0,12}(?:아니|없|싫)|(?:내|우리)\s*차례|싫어\s*[.!?]|섭섭|서운/u.test(u.speech));
  const topicClosure=ordinaryRecall ? undefined : policies.topicClosureVersion;
  // Only this actor's own saved decision can retire optional recall. Real
  // deliveries, a new question or a voiced objection can reopen the subject.
  const newest=visible.filter(u=>u.sequence>(last?.sequence ?? 0) || fresh.has(u.id));
  const openExchange=repeated?.some(u=>resistsChoice(u.speech)) ||
    newest.some(u=>u.kind==='event' || /[?？]/u.test(u.speech) || resistsChoice(u.speech));
  const latestPolicy=topicClosure==='topic-closure/5' || topicClosure===TOPIC_CLOSURE_VERSION;
  const sameSubject=(a:Set<string>,b:Set<string>)=>[...a].filter(term=>b.has(term)).length>=2;
  const matchedWords=latestPolicy && repeated && relevant.length ? repeated.map(u=>terms(subjectText(u),extended)) : [];
  const matchesSubject=(u:Utterance)=>{
    const words=terms(subjectText(u),extended);
    return matchedWords.some(other=>sameSubject(words,other));
  };
  const personalSource=latestPolicy && repeated && !openExchange && relevant.findLast(matchesSubject);
  // A listener can put a subject down even after the original citation drops
  // out of the 18-line window. A fresh request or another subject still gets
  // ordinary recall. The original messages always reach the actor.
  const idleSubject=latestPolicy && personalSource && recallsPlans(version) && !pendingActivity && newest.length>0 &&
    newest.every(u=>u.kind==='speech' && !/부탁|해\s*줘|주세요|궁금|왜\s|어떻게/u.test(u.speech) && matchesSubject(u));
  const personallySetAside=topicClosure==='topic-closure/4'
    ? repeated && relevant.length>0 && !openExchange && repeated.some(u=>stored.includes(u.sequence)) : !!personalSource;
  const omit = new Set<number>();
  const voices = new Map<string,Utterance>();
  if (repeated) {
    if (topicClosure && !personallySetAside && !(latestPolicy && !openExchange)) {
      // Sharing a noun says nothing about agreeing. Only an identical line from
      // the same speaker is redundant; keep each side's actual words available.
      const seen = new Map<string,number>();
      for (const u of repeated) {
        const key=JSON.stringify([u.speakerId,u.speech.trim()]);
        const prior=seen.get(key);
        if (prior!==undefined) omit.add(prior);
        seen.set(key,u.sequence);
        voices.set(u.speakerId,u);
      }
      for (const u of repeated) if (fresh.has(u.id)) omit.delete(u.sequence);
    } else if (ordinaryRecall || (latestPolicy && !personallySetAside)) {
      // Neutral recurrence alone cannot settle an implicit disagreement. Keep
      // each voice's newest words accessible without replaying every mention.
      for (const u of repeated) voices.set(u.speakerId,u);
      const latest=new Set([...voices.values()].map(u=>u.sequence));
      for (const u of repeated) if (!latest.has(u.sequence) && !fresh.has(u.id)) omit.add(u.sequence);
    } else {
      for (const u of repeated.slice(0,-1)) if (!fresh.has(u.id)) omit.add(u.sequence);
    }
  }
  // Never omit deliveries or a world result. Remove quote duplicates from the
  // optional recall channels only; full original records remain in the store.
  for (const u of relevant) if (u.kind === 'speech' && !fresh.has(u.id)) omit.add(u.sequence);
  const checkpoint = ownTurns >= 3 && ownTurns % 4 === 3;
  const options = new Map<number,Utterance>();
  if (checkpoint) {
    const outcome = visible.slice(-16).findLast(u => u.kind === 'event');
    for (const u of [outcome, repeated?.[0], ...recent.slice(-4)]) {
      if (u && !stored.includes(u.sequence)) options.set(u.sequence,u);
    }
  }
  const offers = [...options.values()].sort((a,b) => a.sequence-b.sequence);
  const goalEvidence = version === CONVERSATION_MEMORY_VERSION && ownTurns >= 3 && (checkpoint || [...terms(goal,true)].some(term => recentTerms.has(term)))
    ? lastGoalResult(visible,actor,goal) : undefined;
  const prospect = recallsPlans(version) ? prospectOnReturn(visible,actor,fresh,last?.sequence ?? 0) : undefined;
  const choice = topicClosure && topicClosure!=='topic-closure/1' ? pendingChoice(visible,actor,last?.sequence ?? 0,fresh,goal) : undefined;
  if (idleSubject && !prospect && !choice) {
    return {context:{quiet:'본인이 이미 답하고 접어 둔 화제의 후속 말이다. 새로 할 말이나 일이 떠오르면 자기 선택을 한다. 그대로 듣는 차례는 speech와 action을 모두 비워 둔다.'},
      quiet:true,omit,offered:[]};
  }
  const context = {
    ...(choice && {pendingChoice:choice,choiceUse:usesSourceReferences(topicClosure)
      ? '이 말을 듣고 무엇을 할지는 내 몫이다. 이미 말한 이유를 다시 변론할 필요는 없다. 짧게 받거나, 말없이 행동하거나, 그대로 있어도 된다.'
      : '상대가 방금 꺼낸 말이다. 내 입장과 맞는 부분만 받아들여도 된다. 내가 물러서거나 마음을 바꾼다면 지금 내게 어떤 사정이 생겼는지에 따른다.'}),
    ...(prospect && {prospective:prospect,timeUse:'이때 본인이 실제로 한 말은 앞으로의 계획이나 가정이었다. 이후 그 일이 일어났다는 관찰이 있어야 지난 경험으로 이야기할 수 있다.'}),
    ...(goalEvidence && {lastGoalObservation:goalEvidence, resultUse:'자기 목표와 관련해 직접 한 행동과 이미 본 결과다. 바뀐 징후나 남은 일이 있을 때만 그 점을 다룬다.'}),
    ...(relevant.length && {setAside:relevant.slice(-3).map(cite)}),
    ...(repeated && !personallySetAside && {repeatedExchange:{turns:repeated.length, last:cite(repeated.at(-1)!),
      ...(topicClosure && {recentVoices:[...voices.values()].sort((a,b)=>a.sequence-b.sequence).slice(-4).map(cite)})}}),
    ...(offers.length && {sources:offers.map(cite), checkpoint:'이미 답을 들었거나 농담·점검을 이쯤에서 놓아도 될 때 그 근거 한 건의 순번을 setAsideSequence로 고른다. 새 질문·미해결·작업 시도만 있으면 null.'}),
    ...((relevant.length || repeated) && {next:personallySetAside
      ? '이 대목은 본인이 이미 내려놓았다. 같은 감상이나 몸짓에 한 번 더 답하지 않고 그대로 있어도 된다. 새 관찰, 남은 이견, 직접 받은 질문에는 그때의 내 생각대로 반응한다.'
      : topicClosure
      ? '같은 소재가 다시 나왔다. 인용은 각자가 실제로 한 말이다. setAside는 본인이 내려놓았던 대목이다. 남의 동의는 그 사람이 밝힌 만큼만 안다. 하고 싶은 말이나 선택이 남았으면 이어 가고, 더 할 말이 없으면 쉬어도 된다.'
      : (ordinaryRecall ? '이 소재로 이미 이야기를 주고받았다.' : '이미 서로 넘긴 대목이다.')+' 덧붙일 새 말이 없으면 그 화제를 여기서 마치고 조용히 있어도 된다. 새 질문·다른 사람의 요청·달라진 현장에는 지금 아는 만큼 답한다. 발언 인용은 그 사람의 말이고 물리적 결과는 관찰로 확인한다.'}),
  };
  return {context, quiet:false, ...(ordinaryRecall && {ordinaryRecall}), omit, offered:offers.map(u => u.sequence)};
}

// The actor already has the full text in deliveries or recall. Keep the
// semantic link to the source without repeating the quotation as another cue.
export function compactDiscussion(context: ConversationMemory['context'], available: number[]) {
  const seen=new Set(available);
  if (context.prospective) seen.add(context.prospective.sequence);
  if (context.lastGoalObservation) seen.add(context.lastGoalObservation.result.sequence);
  const reference=(c:Citation)=>{
    if (seen.has(c.sequence)) return {sequence:c.sequence,...(c.speaker && {speaker:c.speaker})};
    seen.add(c.sequence);
    return c;
  };
  const {pendingChoice, repeatedExchange, setAside, sources}=context;
  return {...context,
    ...(pendingChoice && {pendingChoice:{...pendingChoice,otherWords:reference(pendingChoice.otherWords),
      ...(pendingChoice.ownWords && {ownWords:reference(pendingChoice.ownWords)})}}),
    ...(repeatedExchange && {repeatedExchange:{...repeatedExchange,last:reference(repeatedExchange.last),
      ...(repeatedExchange.recentVoices && {recentVoices:repeatedExchange.recentVoices.map(reference)})}}),
    ...(setAside && {setAside:setAside.map(reference)}),
    ...(sources && {sources:sources.map(reference)})};
}

export function withMemoryCheckpoint<T extends {properties?:object;required?:string[]}>(schema: T, offered: number[]) {
  if (!offered.length) return schema;
  return {...schema, properties:{setAsideSequence:{anyOf:[{type:'integer' as const,enum:offered},{type:'null' as const}]}, ...schema.properties},
    required:['setAsideSequence',...(schema.required ?? [])]};
}

export function rememberSource(stored: number[], selected: unknown, offered: unknown) {
  if (typeof selected !== 'number' || !Array.isArray(offered) || !offered.includes(selected)) return stored;
  return [...stored.filter(seq => seq !== selected),selected].slice(-4);
}
