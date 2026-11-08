import type { Utterance } from '../shared/types.js';

export const SCENE_OBSERVATION_VERSION = 'scene-observation/1' as const;

// Older canon presets put their evaluation reference before the event. A
// notice or quotation such as "[방송]" is itself observable and stays intact.
export function authoredObservation(text: string, observation?: string) {
  if (observation !== undefined) return observation;
  const body=text.replace(/^\s*\[[A-Z][A-Z0-9]*-E\d+\s*\/[^\]\r\n]+\]\s*/u,'');
  return body.trim() ? body : text;
}

// Receipts still point to the same committed record. Only the observed text
// crosses into the character's input; the report retains the adjudication.
export function eventMessage(u: Utterance) {
  return {id:u.id,sequence:u.sequence,kind:u.kind,observation:u.speech,
    ...(u.perception && {locationId:u.perception.locationId}),
    ...((u.perception || u.worldEvent) && {virtualSeconds:u.perception?.virtualSeconds ?? u.worldEvent?.virtualSeconds}),
    ...(u.resolution && {resolution:{sourceUtteranceId:u.resolution.sourceUtteranceId,actionId:u.resolution.actionId}})};
}
