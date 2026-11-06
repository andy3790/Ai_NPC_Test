import { environmentMode } from '../shared/schema.js';
import type { Run, Utterance } from '../shared/types.js';

export const isSilentTurn = (u: Utterance) => u.kind === 'speech' && !u.speech.trim() && !u.action.trim() && !u.actionId;

// Only explicit, pure-dialogue runs may finish this way. Pending future events
// and a newly observed event both require another chance to react.
export function dialogueIsIdle(run: Run, history: Utterance[]) {
  if (!run.variant.stopOnSilence || environmentMode(run.spec, run.variant) !== 'off' ||
      run.spec.scheduledEvents.some((_, index) => !run.appliedEvents.includes(index))) return false;
  const silent = new Set<string>();
  for (let i = history.length - 1; i >= 0; i--) {
    const u = history[i];
    if (!isSilentTurn(u)) return false;
    silent.add(u.speakerId);
    if (run.spec.scenario.characters.every(c => silent.has(c.id))) return true;
  }
  return false;
}
