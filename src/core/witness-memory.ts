import type { Character } from '../shared/schema.js';
import type { Utterance } from '../shared/types.js';
import { receives, visibleUtterance } from './perception.js';

export const WITNESS_MEMORY_VERSION='witness-memory/3' as const;
type WitnessVersion='witness-memory/1'|'witness-memory/2'|typeof WITNESS_MEMORY_VERSION;
export const witnessVersionFor=(hasWorldResults:boolean):WitnessVersion=>hasWorldResults ? WITNESS_MEMORY_VERSION : 'witness-memory/2';
type Person=Pick<Character,'id'|'name'>;
type Place={id:string;name:string};
type Question={seq:number; text:string; to:string; kind:string; terms:string[]; beat:number; at:number; answer?:string};
type Check={seq:number; text:string; subject:string; terms:string[]; place:string|null; beat:number};
type Personal={beat:number; questions:Question[]; checks:Check[]};
type ActionSource={actor:string; action:string; witnesses:string[]|undefined; place:string|null};
type Choice={speech:string;action:string;moveToLocationId?:string|null;actionId?:string|null;activityChoice?:string;
  communication?:{mode:string;targetNpcIds:string[];channelId:string|null};followThrough?:{intention:string}|null};
export type WitnessEdit={patch:Partial<Choice>; questions:number[]; checks:number[]};

const parts=(s:string)=>s.match(/[^.!?…。！？\n]+[.!?…。！？]*|[.!?…。！？]+/gu) ?? [];
const questionEnd=/[?？]|(?:나요|인가요|을까요|일까요|습니까|했니)[.。…]*$/u;
const health=/괜찮|나아|나았|아프|아픈|불편|편해|회복|통증|feel(?:ing)? (?:better|okay)|still hurt/iu;
const inspect=/점검|살펴|살피|확인|검사|검수|검토|진단|측정|inspect|check|examin/iu;
const prospective=/할게|볼게|볼래|겠습니다|하려|해봐야|해\s*볼까|해\s*보겠|할까|봐야|I(?:'ll| will| am going to)/iu;
const stable=/정상|(?:경고|문제|이상|파손|흔들림|누수|손상|잡음).{0,12}(?:없|사라|멎)|단단|고정(?:됐|되었|되어|돼|됐다)|(?:소리|진동|소음).{0,12}(?:줄|잦아|멈)|안정|제대로 작동|정상 범위|intact|no (?:fault|damage)|securely|working normally/iu;
const unresolved=/확인.{0,8}(?:못|어렵|불가|할 수 없)|(?:아직|여전히).{0,18}(?:느슨|불안정|남아|남았|이상하)|(?:원인|상태).{0,6}(?:불명|알 수 없)|not yet|unable to/iu;
const physicalResult=/조여(?:져|지|졌)|잦아(?:들|든)|(?:이상|손상|풀림|흔적).{0,20}(?:발견되지 않|보이지 않|찾을 수 없)|(?:제자리|제 위치).{0,8}(?:고정|맞물)|tightened|no longer rattl/iu;
const notResolved=/단단하지 않|고정(?:되지|되지도|하지) 않|정상이 아니|(?:지만|으나|지만,).{0,22}(?:떨|흔들|손상|느슨|걸린)/u;
const change=/다시.{0,15}(?:울리|울렸|들리|커졌|흔들|발생|아프|아파|느슨|덜컹|떨어)|고장|깨[졌진]|풀[렸린]|꺼[졌진]|멈췄|끊[겼긴]|커[졌진]|심해[졌진]|흔들린|재발|이상음|타는 냄새|(?:덜컹거리|흔들리)기 시작|(?:균열|이상|소음|통증).{0,6}(?:생겼|발생|감지)|경고.{0,7}(?:켰|켜졌|떴|울렸|들어왔)|worsen|broke|new alarm|loosened/iu;
const speculative=/[?？]|(?:이상|고장|문제|경고).{0,8}(?:없|아니)|(?:나면|있으면|생기면|울리면|일지도|인지는|같으면)|(?:혹시|만약).{0,20}(?:모르|대비)|\b(?:if|might)\b/iu;
const insist=/못\s*들|다시\s*(?:묻|물어|말해|말씀)|대답(?:해|하라|하라고)|아까랑.{0,12}달라|다그치|다그쳐|say that again|didn.t hear/iu;
const filler=/^(?:나|난|내|너|네|저|제|그|좀|더|또|이제|그럼|먼저|한번|한|번|다시|잠깐|지금|여기|거기|그쪽|대체|오늘|요즘|아직|가까이|상태|쪽|부분|씨|님|혹시|조금|정도|하나|직접|가서|돌아가|the|is|are|you|your|to|an?|i|how|do|feel|still|better|okay|now|at|it)$/iu;
const verb=/^(?:괜찮|나아|나았|좋아|살피|살펴|보겠|확인|점검|검수|검토|측정|검사|조용|정리|작동|했|하는|하겠|하고싶|같|마저|가까이|단단|줄어|다행|있[어는]|없[어는]|어떻|어때|어떤|무엇|얼마|왜|어디|누가|언제|그대로|조심|잠시|해볼|봐줄|돌아[갈가]|검증|check|inspect|examin)/iu;

function words(text:string, skip:ReadonlySet<string>) {
  const result=new Set<string>();
  for (const token of text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    // Strip particles only when a stem remains (귀는 → 귀, but 이 → 이).
    const w=token.replace(/^(.+?)(?:에게서|으로부터|으로|에서는|에서|에는|에도|까지|부터|처럼|이랑|하고|랑|은|는|이|가|을|를|의|와|과|에|도|만|쯤)$/u,'$1');
    if (!filler.test(w) && !verb.test(w) && !skip.has(w)) result.add(w.replace(/^([가-힣]{2,})음$/u,'$1'));
  }
  return [...result];
}
function addressed(line:string, speaker:string, cast:Person[], targets:string[], heard?:string[]) {
  const others=cast.filter(c=>c.id!==speaker);
  const names=others.filter(c=>new RegExp('(?:^|[\\s,，])'+escapeName(c.name)+'(?:\\s*(?:씨|님)|[아야])?(?:[,，\\s]|$)','u').test(line));
  const possible=heard ?? others.map(c=>c.id);
  const id=names.length===1 ? names[0].id : targets.length===1 ? targets[0] : possible.length===1 ? possible[0] : undefined;
  return id && (!heard || heard.includes(id)) ? id : undefined;
}
function inquiry(text:string, speaker:string, cast:Person[], targets:string[], skip:Set<string>, heard?:string[]) {
  if (!questionEnd.test(text) || insist.test(text)) return;
  const to=addressed(text,speaker,cast,targets,heard); if (!to) return;
  const kind=health.test(text)?'condition':/얼마|몇|how many|how much/iu.test(text)?'quantity'
    :/왜|이유|why/iu.test(text)?'reason':/언제|when/iu.test(text)?'time':/어디|where/iu.test(text)?'place':'question';
  const terms=words(text,skip);
  return {to,kind,terms};
}
function sameQuestion(a:Pick<Question,'to'|'kind'|'terms'>,b:Pick<Question,'to'|'kind'|'terms'>) {
  if (a.to!==b.to || a.kind!==b.kind) return false;
  const same=a.terms.filter(w=>b.terms.includes(w)).length;
  return a.kind==='condition' && (!a.terms.length && !b.terms.length || same>0 && same===Math.min(a.terms.length,b.terms.length))
    || same>=2 && same/Math.max(a.terms.length,b.terms.length)>=0.75;
}
const genericFacet=/^(?:소리|진동|소음|이상|문제|표시|경고|불빛|고정|수치|결과|noise|sound|reading)$/iu;
const escapeName=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&');
const actuallyChanged=(s:string)=>change.test(s) && !speculative.test(s) && !prospective.test(s);
const faultObserved=/(?:쇳소리|긁히는 소리|마찰음|탄내|연기|불꽃|균열|누수).{0,12}(?:난다|났다|들린다|들렸다|보인다|보였다|생겼다|피어오|번진다)|(?:물이|기름이).{0,8}(?:샌다|샜다|새어 나온다)/u;
const incidentalTrip=/(?:하러|보러|살피러)\s*(?:갈게|갈래|가겠|가볼)/u;
const visitToInspect=/보러\s*(?:[가갈갔]|다녀)|보고\s*(?:올게|올래|오겠)|들여다(?:보|본)|둘러(?:보|본)/u;
const inspectionMethod=/(?:손(?:끝)?으로|눈으로|육안으로|귀로|살짝|가볍게|지그시|눌러\s*(?:보고)?|있는지|없는지)(?=\s|$)/gu;
const continuingFault=/(?:진동음?|소음|잡음|울림|통증|과열|누수|이상음).{0,12}(?:계속|여전|남아|남았|다시 난다)|(?:여전히|계속).{0,9}(?:진동|떨린다|흔들린다)/u;
const instant=(u:Utterance)=>u.perception?.virtualSeconds ?? u.worldEvent?.virtualSeconds ?? u.sceneSeconds ?? 0;
const objectWord=(w:string)=>!genericFacet.test(w) && /^(?:[가-힣]{2,6}|[a-z]{3,})$/iu.test(w) && !/습니다|된다|한다|됐다|으로|보이지|다만|현재|흔적/u.test(w);

// Rebuild from the committed ledger on restart. A shared spatial decision batch
// advances this index once and all readers see the same pre-batch observations.
export class WitnessMemory {
  private readonly people=new Map<string,Personal>();
  private readonly sources=new Map<string,ActionSource>();
  private readonly skip:Set<string>;
  private through=0;
  private lastId?:string;
  constructor(private readonly cast:Person[],private readonly places:Place[]=[],private readonly version:WitnessVersion=WITNESS_MEMORY_VERSION) {
    this.skip=new Set([...cast,...places].map(c=>c.name.toLowerCase()));
  }
  observe(history:Utterance[]) {
    if (this.through && history[this.through-1]?.id!==this.lastId) {
      this.people.clear();this.sources.clear();this.through=0;
    }
    for (;this.through<history.length;this.through++) {
      const u=history[this.through];this.lastId=u.id;
      if (u.kind==='speech' && u.action.trim()) this.sources.set(u.id,{
        actor:u.speakerId,action:u.action,witnesses:u.perception?.actionRecipientIds,place:u.perception?.locationId ?? null,
      });
      if (u.timeCut) continue;
      const questions=u.kind==='speech' ? parts(u.speech).flatMap(part=>{
        const q=inquiry(part,u.speakerId,this.cast,u.spatialIntent?.communication.targetNpcIds ?? [],this.skip,u.perception?.speechRecipientIds);
        return q ? [{...q,text:part.trim().slice(0,175)}] : [];
      }) : [];
      for (const actor of this.cast) {
        if (u.speakerId!==actor.id && !receives(u,actor.id)) continue;
        const seen=visibleUtterance(u,actor.id);
        if (!seen.speech.trim() && !seen.action.trim()) continue;
        const state=this.people.get(actor.id) ?? {beat:0,questions:[],checks:[]};
        this.people.set(actor.id,state);
        if (seen.kind==='speech' && seen.speech.trim()) {
          state.beat++;
          state.questions=state.questions.filter(q=>state.beat-q.beat<=8 && instant(u)-q.at<300);
          for (const q of state.questions) {
            if (q.to!==u.speakerId || q.answer || questionEnd.test(seen.speech)) continue;
            const reply=words(seen.speech,this.skip);
            const onSubject=reply.some(w=>q.terms.includes(w));
            if (q.kind==='condition' ? health.test(seen.speech) && (onSubject || !q.terms.length || !/[가-힣]+(?:은|는|이|가)\s/u.test(seen.speech)) : onSubject)
              q.answer=seen.speech.slice(0,150);
          }
          for (const q of questions) state.questions=[...state.questions.filter(old=>!sameQuestion(old,q)),
            {...q,seq:u.sequence,beat:state.beat,at:instant(u)}].slice(-6);
        }
        const place=u.perception?.locationId ?? null;
        // The world can establish a new physical condition with unfamiliar
        // wording. Only recipients of the event know to reopen the question.
        if (this.version==='witness-memory/3' && seen.speech && u.worldEvent?.type==='physical_effect' && u.worldEvent.npcId) {
          const affected=u.worldEvent.npcId,observed=words(seen.speech,this.skip);
          state.questions=state.questions.filter(q=>q.kind!=='condition' || q.to!==affected ||
            q.terms.length>0 && !q.terms.some(w=>observed.includes(w)));
        }
        for (const evidence of [seen.speech,seen.action]) for (const line of parts(evidence)) {
          const observedFault=this.version!=='witness-memory/1' && (faultObserved.test(line) || this.version==='witness-memory/3' && continuingFault.test(line)) && !speculative.test(line) && !prospective.test(line);
          if (!actuallyChanged(line) && !observedFault) continue;
          const terms=words(line,this.skip),named=this.places.filter(p=>line.includes(p.name));
          const remote=evidence===seen.speech && u.spatialIntent?.communication.mode==='channel';
          const before=state.checks;
          state.checks=before.filter(c=>{
            const local=named.length ? named.some(p=>p.id===c.place) : !c.place || (!remote && place ? place===c.place
              : !before.some(other=>other.subject===c.subject && other.place!==c.place));
            const matched=terms.filter(w=>c.terms.includes(w) && !genericFacet.test(w));
            return !(local && (terms.includes(c.subject) || matched.length>=2));
          });
          state.questions=state.questions.filter(q=>{
            const person=this.cast.find(c=>c.id===q.to);
            const namedPerson=person && new RegExp('(?:^|[\\s,])'+escapeName(person.name)+'(?:\\s*(?:씨|님)|[이가은는을를의]|[\\s,]|$)','u').test(line);
            const aboutTarget=u.speakerId===q.to || u.worldEvent?.npcId===q.to || u.kind==='event' && namedPerson;
            return !(aboutTarget && terms.some(w=>q.terms.includes(w)));
          });
        }
        if (seen.kind==='event') this.confirm(state,actor.id,u,seen.speech);
      }
    }
    return this;
  }

  private confirm(state:Personal,actor:string,u:Utterance,text:string) {
    const sourceId=u.resolution?.sourceUtteranceId ?? (u.worldEvent?.type==='actor_result' ? u.worldEvent.sourceUtteranceId : null);
    if (!sourceId) return;
    const directResult=this.version!=='witness-memory/1';
    if (!(stable.test(text) || directResult && physicalResult.test(text))
      || unresolved.test(text) || directResult && notResolved.test(text)
      || this.version==='witness-memory/3' && (continuingFault.test(text) || faultObserved.test(text))
      || change.test(text) && !speculative.test(text)) return;
    const source=this.sources.get(sourceId);
    const sawAction=source && (source.actor===actor || !source.witnesses || source.witnesses.includes(actor));
    const attempt=sawAction ? source.action : '';
    if (!directResult && !inspect.test(attempt)) return;
    const mentioned=words(attempt,this.skip),confirmed=words(text,this.skip);
    // An observer can identify an object from a public result without knowing
    // the private action that produced it, or the place where it happened.
    const subject=directResult ? mentioned.find(w=>confirmed.includes(w)) ?? confirmed.find(objectWord)
      : confirmed.find(w=>mentioned.includes(w));
    if (!subject) return;
    const place=u.perception?.locationId ?? (attempt ? source?.place : null) ?? null;
    const check={seq:u.sequence,text:text.slice(0,200),subject,terms:confirmed,place,beat:state.beat};
    state.checks=[...state.checks.filter(c=>c.subject!==subject || c.place!==place),check].slice(-8);
  }
  view(actor:string,time:number) {
    const state=this.people.get(actor);
    return {beat:state?.beat ?? 0,questions:state?.questions.filter(q=>time-q.at<300) ?? [],checks:state?.checks ?? []};
  }
  context(view:ReturnType<WitnessMemory['view']>,place:string|null) {
    const questions=view.questions.filter(q=>view.beat-q.beat<=4).slice(-2);
    const checks=view.checks.filter(c=>view.beat-c.beat<=2 || c.place===place && view.beat-c.beat<=6).slice(-1);
    if (!questions.length && !checks.length) return;
    return {
      ...(questions.length && {heard:questions.map(q=>({to:this.cast.find(c=>c.id===q.to)?.name,asked:q.text,...(q.answer && {answered:q.answer})}))}),
      ...(checks.length && {verified:checks.map(c=>({...(c.place && {place:this.places.find(p=>p.id===c.place)?.name}),result:c.text}))}),
      use:'직접 들은 질문은 상대가 대답할 자리를 둔다. 이미 확인한 상태는 새 징후가 있거나 다른 부분을 볼 때 이어 간다. 다른 일이나 침묵도 고를 수 있다.',
    };
  }
  edit(view:ReturnType<WitnessMemory['view']>,actor:string,location:string|null,choice:Choice):WitnessEdit|undefined {
    const patch:Partial<Choice>={},questions=new Set<number>(),checks=new Set<number>();
    const checking=(line:string,spoken:boolean)=>{
      const expanded=this.version==='witness-memory/3';
      const verbAt=line.search(inspect);
      const start=verbAt>=0 ? verbAt : expanded ? line.search(visitToInspect) : -1;
      const proposes=prospective.test(line) || this.version!=='witness-memory/1' && incidentalTrip.test(line)
        || expanded && /보고\s*(?:올게|올래|오겠)/u.test(line);
      if (start<0 || spoken && (!proposes || questionEnd.test(line)) || choice.actionId || ['continue','cancel'].includes(choice.activityChoice ?? '')) return;
      const named=this.places.filter(p=>line.includes(p.name));
      const place=named.length===1?named[0].id:choice.moveToLocationId ?? location;
      // Keep compound choices intact when inspection is just one of their actions.
      if (/(?:하고|한 뒤|한 다음|하면서|해 보고|살펴보고|살피고|and then)\s+\S/iu.test(line.slice(start))) return;
      const before=line.slice(0,start).split(/[,，]/u).at(-1) ?? '';
      const focus=words(expanded ? before.replace(inspectionMethod,' ') : before,this.skip);
      return view.checks.findLast(c=>{
        if (c.place!==place || !focus.includes(c.subject)) return false;
        // Touch and sight can probe the same fastening. A different component
        // or property (such as bearing temperature) still needs a fresh check.
        const fixed=expanded && /단단|고정|조여|체결|secure|fasten/iu.test(c.text);
        return focus.every(w=>c.terms.includes(w) || fixed && /^(?:흔들림|유격|풀림)$/u.test(w));
      });
    };
    for (const field of ['speech','action'] as const) {
      const kept:string[]=[];let changed=false;
      for (const line of parts(choice[field])) {
        const q=field==='speech' && inquiry(line,actor,this.cast,choice.communication?.targetNpcIds ?? [],this.skip);
        const prior=q && view.questions.findLast(old=>sameQuestion(old,q));
        const check=checking(line,field==='speech');
        if (prior || check) {
          if (prior) questions.add(prior.seq);
          if (check) checks.add(check.seq);
          changed=true;
        } else kept.push(line);
      }
      if (changed) patch[field]=kept.join('').trim();
    }
    if (!questions.size && !checks.size) return;
    if (patch.speech==='' && choice.communication) patch.communication={mode:'none',targetNpcIds:[],channelId:null};
    const remainingAction=(patch.action ?? choice.action).trim();
    if (checks.size && choice.moveToLocationId && view.checks.some(c=>checks.has(c.seq) && c.place===choice.moveToLocationId)) {
      const speech=patch.speech ?? choice.speech;
      const knownPlace=this.places.map(p=>escapeName(p.name)).join('|');
      const stands=this.version==='witness-memory/3' ? '(?:자리|의자)' : '자리';
      const travelOnly=knownPlace && new RegExp('^(?:'+stands+'에서\\s*일어나\\s*)?(?:'+knownPlace+')(?:로|으로|쪽을|을|를)\\s*(?:향한다|걸어간다|이동한다|돌아간다|나선다|나온다)[.]?$','u').test(remainingAction);
      const linked=this.version!=='witness-memory/1' ? (!remainingAction || travelOnly) && !/가서|가져|들르|갈게|옮길|전해|만나러/u.test(speech)
        : (!remainingAction || /^[^,.!?]{0,35}(?:로|으로|쪽을)\s*(?:향한다|걸어간다|이동한다|돌아간다)[.]?$/u.test(remainingAction)) && !speech.includes('가서');
      if (linked) {
        patch.moveToLocationId=null;
        if (remainingAction) patch.action='';
      }
    }
    if (choice.followThrough && (!((patch.speech ?? choice.speech).trim() || (patch.action ?? choice.action).trim()) || checking(choice.followThrough.intention,false)))
      patch.followThrough=null;
    return {patch,questions:[...questions],checks:[...checks]};
  }
}
