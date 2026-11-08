import { environmentMode } from '../shared/schema.js';
import type { Run, Utterance } from '../shared/types.js';
import { receives } from './perception.js';

export const isSilentTurn = (u: Utterance) => u.kind === 'speech' && !u.speech.trim() && !u.action.trim() && !u.actionId;

// Only explicit, pure-dialogue runs may finish this way. Pending future events
// and a newly observed event both require another chance to react.
export function dialogueEnding(run: Run, history: Utterance[]): 'conversation_idle' | 'conversation_withdrawn' | undefined {
  if (!run.variant.stopOnSilence || environmentMode(run.spec, run.variant) !== 'off' ||
      run.spec.scheduledEvents.some((_, index) => !run.appliedEvents.includes(index))) return;
  // One participant can leave a conversation on their own. The other gets
  // a last turn. This closes only the exchange, never a location or world.
  const last=history.at(-1);
  const cast=run.spec.scenario.characters;
  if (run.socialReactionVersion && cast.length===2 && last?.kind==='speech') {
    const other=cast.find(c=>c.id!==last.speakerId)!;
    const choice=run.sessions[other.id]?.socialMemory?.find(m=>m.peerId===last.speakerId && m.stance==='대화를 끊음');
    if (choice && last.sequence>choice.sequence && !history.some(u=>u.sequence>choice.sequence && u.kind==='event' && cast.some(c=>receives(u,c.id))))
      return 'conversation_withdrawn';
  }
  const silent = new Set<string>();
  for (let i = history.length - 1; i >= 0; i--) {
    const u = history[i];
    if (!isSilentTurn(u)) return;
    silent.add(u.speakerId);
    if (run.spec.scenario.characters.every(c => silent.has(c.id))) return 'conversation_idle';
  }
}

export const dialogueIsIdle = (run:Run,history:Utterance[]) => dialogueEnding(run,history)==='conversation_idle';
