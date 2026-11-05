import { z } from 'zod';
import { characterSchema, experimentSchema, scenarioSchema, type ExperimentSpec } from './schema.js';

export type ConfigSection = 'full' | 'world' | 'character' | 'characters' | 'conditions';
export const configSectionLabels: Record<ConfigSection, string> = {
  full: '전체 설정', world: '세계관', character: '선택 캐릭터', characters: '전체 캐릭터', conditions: '실험 조건',
};
const worldSchema = z.strictObject({
  id: scenarioSchema.shape.id, name: scenarioSchema.shape.name,
  world: scenarioSchema.shape.world, situation: scenarioSchema.shape.situation,
  defaults: scenarioSchema.shape.defaults, environment: scenarioSchema.shape.environment,
  worldEngineInstructions: scenarioSchema.shape.worldEngineInstructions,
  spatial: scenarioSchema.shape.spatial,
});
const conditionsSchema = z.strictObject({
  variants: experimentSchema.shape.variants, repetitions: experimentSchema.shape.repetitions,
  maxUtterances: experimentSchema.shape.maxUtterances, concurrentRuns: experimentSchema.shape.concurrentRuns,
  maxConcurrentCalls: experimentSchema.shape.maxConcurrentCalls, timeoutMs: experimentSchema.shape.timeoutMs,
  evaluation: experimentSchema.shape.evaluation, director: experimentSchema.shape.director,
  worldEngine: experimentSchema.shape.worldEngine,
  eventGenerator: experimentSchema.shape.eventGenerator,
  scheduledEvents: experimentSchema.shape.scheduledEvents,
});
function characterAt(spec: ExperimentSpec, index: number) {
  const character = spec.scenario.characters[index];
  if (!character) throw new Error('편집할 캐릭터를 선택하세요.');
  return character;
}
export function readConfigSection(spec: ExperimentSpec, section: ConfigSection, characterIndex = 0): unknown {
  let result: unknown;
  if (section === 'full') result = spec;
  else if (section === 'world') { const { characters: _characters, ...world } = spec.scenario; result = world; }
  else if (section === 'character') result = characterAt(spec, characterIndex);
  else if (section === 'characters') result = spec.scenario.characters;
  else result = Object.fromEntries(Object.keys(conditionsSchema.shape).filter(key => spec[key as keyof ExperimentSpec] !== undefined).map(key => [key, spec[key as keyof ExperimentSpec]]));
  return structuredClone(result);
}
// Validate the replacement, then the assembled experiment, before changing UI state.
// Cross-section actor references and run limits must remain valid as well.
export function applyConfigSection(spec: ExperimentSpec, section: ConfigSection, value: unknown, characterIndex = 0): ExperimentSpec {
  const next = structuredClone(spec);
  if (section === 'full') return experimentSchema.parse(value);
  if (section === 'world') next.scenario = { ...worldSchema.parse(value), characters: next.scenario.characters };
  else if (section === 'character') {
    characterAt(next, characterIndex);
    next.scenario.characters[characterIndex] = characterSchema.strict().parse(value);
  } else if (section === 'characters') next.scenario.characters = z.array(characterSchema.strict()).min(2).max(30).parse(value);
  else { const conditions = conditionsSchema.parse(value); delete next.worldEngine; delete next.eventGenerator; Object.assign(next, conditions); }
  return experimentSchema.parse(next);
}
export function configSectionError(error: unknown) {
  if (error instanceof z.ZodError) return error.issues.map(issue => `${issue.path.length ? issue.path.join('.') + ': ' : ''}${issue.message}`).join('\n');
  return error instanceof Error ? error.message : String(error);
}
