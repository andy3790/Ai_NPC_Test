import { z } from 'zod';
import { attentionChoices, phrasingChoices, performanceSchema, type Performance, type PerformanceVersion, type StoredPerformance } from '../shared/character-performance.js';
import type { Character } from '../shared/schema.js';
import type { InvocationMetrics, NpcSession, Utterance } from '../shared/types.js';
import { receives, visibleUtterance } from './perception.js';
import { spokenReaction } from './social-reaction.js';

export const performanceInstructions = `인물의 성격이 한두 단어라면 지금 서로 바라는 게 다를 때 무엇을 고르거나 양보할지를 그 단서로 정하세요. 조금 전 질문에 자기 답을 하고 일상 얘기는 그 얘기로 이어 가세요. 맡은 일은 실제로 상황이 그 일로 돌아왔을 때 챙기세요. 이미 들은 이유나 했던 동작을 같은 자리에서 매번 되풀이할 필요가 없습니다. 설명을 청하거나 사정이 달라지면 필요한 만큼 답하세요.
characterPerformance는 본인에게만 주는 연기 참고입니다. 첫 선택에서 설정에 어울리는 관심의 방향과 말의 박자를 골라 portrayal에 담으세요. 이후에도 여러 반응이 가능할 때 참고하세요. 질문·부탁·관계와 본인이 정한 말투가 우선입니다. 매번 그 특징을 연기하거나 말로 소개하지 마세요. earlierWords가 있으면 그때 했던 말입니다. 그 답이 아직 맞는지 생각하고, 바꿀 때에도 지금 대화에 맞게 답하세요. 예전 문장을 그대로 읊을 필요는 없습니다.`;
export const rhythmInstruction = '말높임만 정해졌거나 여러 박자가 자연스러우면 possiblePhrasing을 출발점으로 삼으세요. 명시된 말투나 예문에 더 어울리는 박자가 있으면 그걸 고르세요. 자기 취향·머뭇거림·양보를 드러낼 만한 순간에는 구체적으로 반응하고, 가벼운 대꾸는 가볍게 지나가세요.';

function hasCharacterDirection(c: Character) {
  return [c.identity, c.personality, c.speechStyle, c.exampleDialogue, c.behaviors, c.goals, c.values,
    c.relationships, c.memories, c.knowledge, c.unknowns, c.taboos].some(value => value.trim());
}

// Cast order is frozen in the run snapshot. The two cycles give the 30
// supported slots distinct pairs without adding fictional facts.
function neutralChoices(slot: number): Performance {
  return { attention: attentionChoices[slot % attentionChoices.length],
    phrasing: phrasingChoices[slot % phrasingChoices.length] };
}

const deliveryNotes: Record<Performance['phrasing'],string> = {
  '대답을 먼저 건넨다':'자기 답부터 짧게 건넨다. 상대가 이미 아는 이유까지 다시 풀 필요는 없다.',
  '구체적인 한 대목부터 꺼낸다':'문서나 설명을 통째로 읽기보다 지금 필요한 숫자나 사례 한 가지를 집어 말한다.',
  '말을 하며 생각을 이어 간다':'자기가 이해한 바를 자기 말로 짚는다. 빈틈이 실제로 남을 때만 짧게 되묻는다.',
  '상대의 한마디에 내 생각을 보탠다':'상대 말에서 마음에 걸린 부분 하나에 자기 생각을 보탠다.',
  '생각을 고르고 말을 건넨다':'한 가지를 골라 담담하게 건넨다. 매번 뜸을 들이거나 머뭇거림을 연기할 필요는 없다.',
};
export function lacksVoice(c: Character) {
  return ![c.speechStyle,c.exampleDialogue,c.personality,c.relationships,c.behaviors,c.values].some(value => value.trim());
}

export const SPARSE_VOICE_VERSION = 'sparse-voice/2' as const;
const followUpUnits = [
  [1,2,1], [2,2,2], [2,3,2], [2,2,3], [1,2,2],
] as const;
// On familiar ground give each speaker room for a few complete thoughts.
// A fresh event or request for detail retains the ordinary speech contract.
export function sparseFollowUp(character: Character, slot: number, history: Utterance[], familiar: boolean) {
  if (!familiar || !lacksVoice(character)) return;
  const own=history.filter(u=>u.kind==='speech' && u.speakerId===character.id);
  if (own.length<2) return;
  const last=own.at(-1)!;
  const fresh=history.filter(u=>u.sequence>last.sequence && receives(u,character.id)).map(u=>visibleUtterance(u,character.id));
  if (fresh.some(u=>u.kind==='event' || /자세히|구체적.{0,6}설명|전부|각각|하나씩|[?？].+[?？]/u.test(u.speech))) return;
  const index=slot%phrasingChoices.length;
  const units=followUpUnits[index][own.length%3];
  const usedPolite=!last.perception && own.filter(u=>!u.perception && u.speech.trim()).slice(-3)
    .some(u=>/(?:요|니다|니까|까요)[.!?…]?$/u.test(u.speech.trim()));
  const cadence=index===0 && usedPolite ? '이 상대에게 쓰던 존대를 유지한다. 합의한 일에는 결론 한마디로 답해도 된다. 편한 자리에서는 짧은 해요체도 자연스럽다.' :
    index===1 ? '자기 판단의 근거가 된 한 가지를 앞에 놓고, 이미 말한 명세는 다시 열거하지 않는다.' :
    index===2 ? '상대 표현을 옮겨 적기보다 자기 입장에서 무슨 뜻인지 평소 말로 짚는다. 답을 들었으면 또 묻지 않아도 된다.' : deliveryNotes[phrasingChoices[index]];
  return {units,cadence};
}

export function withSpeechUnits(schema: {properties?:object; required?:string[]}, units: number) {
  return {...schema,properties:{...schema.properties,speech:{type:'array' as const,maxItems:units,items:{type:'string' as const},
    description:'각 항목은 그대로 말하고 멈춰도 자연스러운 대사 한마디입니다. 할 말이 없으면 빈 배열로 두세요.'}}};
}

// Keep the provider transcript intact. Only the public utterance joins the
// spoken units, so delivery, evaluation and replays still receive plain speech.
export function parseSpeechOutput(call: Pick<InvocationMetrics,'output'|'metadata'>) {
  const result=JSON.parse(call.output);
  if (call.metadata.socialBeat) return spokenReaction(result);
  if (call.metadata.sparseVoiceVersion!==SPARSE_VOICE_VERSION) return result;
  const units=call.metadata.speechUnits;
  if (typeof units!=='number' || !Array.isArray(result.speech) || result.speech.length>units ||
      !result.speech.every((part:unknown)=>typeof part==='string' && part.trim()))
    throw Error('대사는 정해진 개수 이내의 완결된 발언 목록이어야 합니다. 침묵은 빈 목록으로 보냅니다.');
  return {...result,speech:result.speech.join(' ')};
}

function terms(text: string) {
  const words = text.normalize('NFC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(words.map(word => word.replace(/(?:에서|으로|이랑|하고|에는|에도|부터|까지|[은는이가을를에와과도])$/u, ''))
    .filter(word => word.length >= 2 && !/^(?:그거|그건|어떻게|그냥|그럼|근데|다시|아까|지금|저번|지난번|어때요|할까요|있어요|그래요)$/u.test(word)));
}

// Recall one actual, committed line only on a return to the subject. A fresh
// receipt already carries its full observation; never replay someone else's
// speech or use a whisper the actor could not hear as a retrieval key.
export function earlierWords(history: Utterance[], actor: string, version: PerformanceVersion = 'character-performance/2') {
  const firstRevision = version === 'character-performance/1';
  const last = history.findLast(u => (!firstRevision || u.kind === 'speech') &&
    (u.speakerId === actor || receives(u, actor)) && visibleUtterance(u, actor).speech.trim());
  if (!last || last.speakerId === actor) return;
  const query = visibleUtterance(last, actor).speech;
  if (!/(?:아까|그때|저번|지난번|지난번에|여전히|아직도|다시|마음.{0,4}바뀌|생각.{0,4}바뀌)/u.test(query)) return;
  const keywords = [...terms(query.slice(-500))];
  let inspected = 0;
  for (let i = history.length - 1; i >= 0 && inspected < 32; i--) {
    const u = history[i];
    if (u.speakerId !== actor || u.kind !== 'speech' || !u.speech.trim()) continue;
    inspected++;
    if (u.spatialIntent && ['whisper', 'channel'].includes(u.spatialIntent.communication.mode)) continue;
    if (u.speech.length > (firstRevision ? 200 : 240)) continue;
    const matched = [...terms(u.speech)].some(term => firstRevision ? keywords.includes(term) :
      keywords.some(key => term.startsWith(key) || key.startsWith(term)));
    if (matched) return { id: u.id, speech: u.speech };
  }
}

export function performTurn(version: PerformanceVersion, character: Character, slot: number, session: Pick<NpcSession, 'performance'>, history: Utterance[]) {
  const prior = session.performance;
  const unspecified = !hasCharacterDirection(character);
  const choices = prior?.choices ?? (unspecified ? neutralChoices(slot) : undefined);
  const fixedPhrasing = version === 'character-performance/3' && lacksVoice(character) ? neutralChoices(slot).phrasing : undefined;
  const recall = earlierWords(history, character.id, version);
  return {
    context: { ...(choices ? { attention: choices.attention, phrasing: choices.phrasing } : {}),
      ...(!prior && !unspecified ? { select: '본인 설정에서 자연스러운 두 항목을 골라 portrayal에 기록하세요.' } : {}),
      ...(version !== 'character-performance/1' && !prior && !unspecified ? { possiblePhrasing: neutralChoices(slot).phrasing } : {}),
      ...(fixedPhrasing && {delivery:deliveryNotes[fixedPhrasing]}),
      ...(recall ? { earlierWords: recall } : {}) },
    select: !prior && !unspecified,
    fixedPhrasing,
    metadata: { characterPerformanceVersion: version, performanceSourceInvocationId: prior?.invocationId ?? null,
      recalledOwnUtteranceId: recall?.id ?? null },
  };
}

const portrayalProperty = z.toJSONSchema(performanceSchema);
// The provider requires all keys in a strict schema. Extend the mode's actual
// speech contract; rule actions and spatial decisions keep their original fields.
export function withPortrayal(schema: { properties?: object; required?: string[] }, fixedPhrasing?: Performance['phrasing']) {
  const property = fixedPhrasing ? {...portrayalProperty,properties:{...portrayalProperty.properties,
    phrasing:{type:'string' as const,enum:[fixedPhrasing]}}} : portrayalProperty;
  return { ...schema, properties: { portrayal: property, ...schema.properties }, required: ['portrayal', ...(schema.required ?? [])] };
}

export function committedPerformance(version: PerformanceVersion, character: Character, slot: number, call: InvocationMetrics): StoredPerformance {
  const unspecified = !hasCharacterDirection(character);
  const selected = performanceSchema.safeParse(JSON.parse(call.output).portrayal);
  return { version, invocationId: call.id,
    choices: unspecified ? neutralChoices(slot) : selected.success ? {
      ...selected.data, ...(version === 'character-performance/3' && lacksVoice(character) && {phrasing:neutralChoices(slot).phrasing}),
    } : undefined,
    source: unspecified ? 'unspecified' : selected.success ? 'profile' : 'fallback' };
}
