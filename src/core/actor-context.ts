import type { Utterance } from '../shared/types.js';
import type { Character } from '../shared/schema.js';
import { receives, visibleUtterance } from './perception.js';

export const ACTOR_CONTEXT_VERSION = 'npc-context/4' as const;
export const LANGUAGE_CHECK_VERSION = 'npc-language/3' as const;
const languageMismatch = '장면과 인물에게 없는 가나 단어가 섞였습니다. 관찰한 뜻을 한국어로 자연스럽게 다시 표현하세요.';
const normalized = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
function grams(s: string) {
  const text = normalized(s);
  return new Set(Array.from({length:Math.max(0,text.length-2)},(_,i) => text.slice(i,i+3)));
}
function overlap(a: Set<string>, b: Set<string>) {
  let same = 0; for (const part of a) if (b.has(part)) same++;
  return 2 * same / Math.max(1,a.size + b.size);
}
// Keep the first witnessed mention of a recurring topic. Matching quotations,
// including those spoken in private, are considered only after observer filtering.
export function establishedConversation(history: Utterance[], actor: string) {
  const heard = history.filter(u => u.kind === 'speech' && (u.speakerId === actor || receives(u,actor)))
    .map(u => visibleUtterance(u,actor)).filter(u => u.speech.trim().length >= 12);
  if (heard.length < 12) return [];
  const recent = heard.slice(-10).map(u => grams(u.speech.slice(0,350)));
  const bySpeaker = new Map<string,{u:Utterance;score:number}>();
  for (const u of heard.slice(0,-10)) {
    const words = grams(u.speech.slice(0,350));
    const hits = recent.map(r => overlap(words,r)).filter(value => value >= .10);
    if (!hits.length) continue;
    const score = hits.reduce((a,b) => a+b,0);
    const prior = bySpeaker.get(u.speakerId);
    if (!prior || score > prior.score * 1.25) bySpeaker.set(u.speakerId,{u,score});
  }
  return [...bySpeaker.values()].sort((a,b) => b.score-a.score).slice(0,5).sort((a,b) => a.u.sequence-b.u.sequence)
    .map(({u}) => ({sequence:u.sequence,speaker:u.speakerName,alreadyHeard:u.speech.slice(0,360)}));
}

// A private goal can stay true long after its owner has told someone about it.
// Retrieve the actual first disclosure, even after the subject has changed.
export function priorDisclosures(history: Utterance[], character: Character, participants: Character[]) {
  const own = history.filter(u => u.kind === 'speech' && u.speakerId === character.id && u.speech.trim().length >= 12);
  if (own.length < 4) return [];
  const cues = [character.goals,character.memories,character.knowledge].flatMap(field => field.slice(0,3600).split(/[.!?。\n]+/u,8))
    .map(cue => grams(cue.slice(0,400))).filter(cue => cue.size >= 6);
  if (!cues.length) return [];
  const candidates = own.slice(0,-3).map(u => ({u,words:grams(u.speech.slice(0,400))}));
  const first = new Map<number,Utterance>();
  for (const cue of cues) {
    const match = candidates.find(({u,words}) => (u.perception?.speechRecipientIds.length ?? 1) > 0 && overlap(cue,words) >= .19);
    if (match) first.set(match.u.sequence,match.u);
  }
  return [...first.values()].slice(0,4).map(u => ({
    sequence:u.sequence,said:u.speech.slice(0,400),
    heardBy:participants.filter(c => c.id !== character.id && (u.perception?.speechRecipientIds.includes(c.id) ?? true)).map(c => c.name),
  }));
}
export function languageRepairSchema(schema: object, languageContext: string, previousError?: string | null) {
  if (!previousError?.includes(languageMismatch) || !/[가-힣]/u.test(languageContext) ||
      /[\u3041-\u3096\u30a1-\u30fa]/u.test(languageContext)) return;
  const properties = (schema as { properties?: Record<string,object> }).properties;
  if (!properties?.speech || !properties.action) return;
  const pattern = '^[^ぁ-ゖァ-ヺ]*$';
  return { ...schema, properties: { ...properties,
    speech: { ...properties.speech, pattern }, action: { ...properties.action, pattern } } };
}
export function checkDialogue(speech: string, action: string, history: Utterance[], actor: string, languageContext: string) {
  const output = speech+' '+action;
  const foreign = [...output.matchAll(/[\u3041-\u3096\u30a1-\u30fa]+/gu)].flatMap(match => {
    if (match[0].length>1) return [match[0]];
    // A single kana attached to a Korean word was missed by the multi-letter
    // check. Match the whole mixed form so an unrelated particle in history cannot authorize it.
    const before=output.slice(0,match.index).match(/[가-힣]+$/u)?.[0] ?? '';
    const after=output.slice(match.index+1).match(/^[가-힣]+/u)?.[0] ?? '';
    return before || after ? [before+match[0]+after] : [];
  });
  if (/[가-힣]/u.test(languageContext) && foreign.some(word => !languageContext.includes(word)))
    throw Error(languageMismatch);
  const line = grams(speech);
  if (line.size < 15) return;
  const previous = history.filter(u => u.speakerId === actor && u.kind === 'speech').slice(-10);
  if (previous.filter(u => overlap(line,grams(u.speech)) >= .72 && (!action.trim() || normalized(action) === normalized(u.action))).length >= 2)
    throw Error('본인이 이미 두 번 이상 전한 말과 같은 내용입니다. 새로 관찰한 변화나 상대의 질문에만 반응하고 할 말이 끝났으면 행동이나 침묵을 선택하세요.');
}

// Provider history also contains obsolete instructions and rejected replies. Only
// committed, visible records may enter the rolling context of an independent turn.
export function actorRecall(history: Utterance[], actor: string, fresh: Set<string>) {
  const observed = history.filter(u => !fresh.has(u.id) && (u.speakerId === actor || receives(u, actor)))
    .map(u => visibleUtterance(u, actor));
  const own = observed.filter(u => u.speakerId === actor);
  const outcomes = observed.filter(u => u.worldEvent || u.resolution);
  const query = grams(history.filter(u => fresh.has(u.id) && receives(u,actor)).map(u => visibleUtterance(u,actor).speech).slice(-3).join(' '));
  const earlier = observed.slice(0,-12).map(u => ({u,score:overlap(query,grams(u.speech+' '+u.action))}))
    .filter(c => c.score > .12).sort((a,b) => b.score-a.score || b.u.sequence-a.u.sequence).slice(0,3);
  const selected = new Set([...earlier.map(c => c.u), ...own.slice(-3), ...outcomes.slice(-4), ...observed.slice(-12)]);
  return observed.filter(u => selected.has(u)).map(u => ({
    sequence: u.sequence, speaker: u.speakerName, kind: u.kind,
    ...(u.speech && { speech: u.speech.slice(0, 500) }), ...(u.action && { action: u.action.slice(0, 350) }),
  }));
}
