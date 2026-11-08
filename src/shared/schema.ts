import { z } from 'zod';
import { DIALOGUE_PROMPT_VERSIONS } from './dialogue-policy.js';
import { performanceVersions } from './character-performance.js';
import { WORLD_PROMPT_VERSIONS } from './world-policy.js';
import { worldOutputSchema } from './world-schema.js';
import { audienceSchema, eventGeneratorSchema, eventProposalSchema, spatialPlanSchema, spatialResolutionSchema, spatialSchema, spatialSpeechSchema } from './spatial-schema.js';

const id = z.string().regex(/^[a-zA-Z0-9_-]+$/).max(100);
const text = z.string().max(100_000);
const stateValue = z.union([z.string().max(1000), z.number().finite(), z.boolean()]);
export const conditionSchema = z.object({ key: id, op: z.enum(['eq', 'neq', 'gte', 'lte']).default('eq'), value: stateValue });
export const environmentSchema = z.object({
  enabled: z.boolean().default(true), stopOnGoals: z.boolean().default(true),
  initialState: z.record(id, stateValue),
  actions: z.array(z.object({ id, label: z.string().min(1), actorIds: z.array(id).min(1),
    conditions: z.array(conditionSchema).default([]), effects: z.record(id, stateValue),
    result: text.min(1), once: z.boolean().default(true),
  })).min(1).max(100),
  goals: z.array(z.object({ id, label: z.string().min(1), conditions: z.array(conditionSchema).min(1) })).min(1).max(50),
});
export type EnvironmentSpec = z.infer<typeof environmentSchema>;
export type State = EnvironmentSpec['initialState'];
export const modelConfig = z.object({ model: z.string().min(1), effort: z.string().min(1) });
export const characterSchema = z.object({
  id, name: z.string().min(1).max(100), identity: text.default(''), personality: text.default(''),
  values: text.default(''), goals: text.default(''), relationships: text.default(''),
  memories: text.default(''), knowledge: text.default(''), unknowns: text.default(''),
  speechStyle: text.default(''), exampleDialogue: text.default(''), behaviors: text.default(''), taboos: text.default(''),
  model: z.string().optional(), effort: z.string().optional(),
});
export const scenarioSchema = z.object({
  id, name: z.string().min(1), world: text.min(1), situation: text.min(1),
  characters: z.array(characterSchema).min(2).max(30),
  defaults: modelConfig,
  environment: environmentSchema.optional(),
  worldEngineInstructions: text.optional(),
  spatial: spatialSchema.optional(),
  clockEvents: z.array(z.object({ id, atSeconds: z.number().finite().nonnegative(), text: text.trim().min(1),
    locationIds: z.array(id).max(100).optional() })).max(100).optional(),
}).superRefine((v, c) => {
  if (new Set(v.characters.map(x => x.id)).size !== v.characters.length)
    c.addIssue({ code: 'custom', message: '캐릭터 ID는 중복될 수 없습니다.' });
  if (new Set(v.clockEvents?.map(e => e.id)).size !== (v.clockEvents?.length ?? 0))
    c.addIssue({ code: 'custom', path:['clockEvents'], message:'시각 사건 ID는 중복될 수 없습니다.' });
  for (const event of v.clockEvents ?? []) if (event.locationIds && (!event.locationIds.length ||
    new Set(event.locationIds).size !== event.locationIds.length || event.locationIds.some(id => !v.spatial?.locations.some(l => l.id === id))))
    c.addIssue({ code:'custom', path:['clockEvents'], message:'시각 사건의 현장 수신 장소를 확인하세요.' });
  if (v.spatial) {
    const s = v.spatial;
    const fail = (message: string) => c.addIssue({ code: 'custom', path: ['spatial'], message });
    for (const values of [s.locations.map(x => x.id), s.connections.map(x => x.id), s.channels.map(x => x.id), s.initialPositions.map(x => x.npcId)])
      if (new Set(values).size !== values.length) fail('장소·통로·채널·초기 NPC 위치의 ID는 각각 중복될 수 없습니다.');
    const place = (id: string) => s.locations.some(x => x.id === id);
    const npc = (id: string) => v.characters.some(x => x.id === id);
    for (const route of s.connections) if (!place(route.from) || !place(route.to) || route.from === route.to) fail(`잘못된 연결 통로: ${route.id}`);
    if (s.initialPositions.length !== v.characters.length || s.initialPositions.some(x => !npc(x.npcId) || !place(x.locationId))) fail('모든 NPC의 시작 장소를 한 번씩 지정하세요.');
    for (const channel of s.channels) if (new Set(channel.memberNpcIds).size !== channel.memberNpcIds.length || channel.memberNpcIds.some(x => !npc(x))) fail(`잘못된 통신 채널 참가자: ${channel.id}`);
    const limits = s.travelLimits ?? [];
    if (limits.some(l => !npc(l.npcId) || !place(l.locationId)) || new Set(limits.map(l => l.npcId + ':' + l.locationId)).size !== limits.length)
      fail('이동 제약에는 실제 NPC와 목적지 조합을 한 번씩 지정하세요.');
  }
  const env = v.environment;
  if (!env) return;
  const fail = (message: string) => c.addIssue({ code: 'custom', message });
  if (new Set(env.actions.map(a => a.id)).size !== env.actions.length || new Set(env.goals.map(g => g.id)).size !== env.goals.length) fail('행동·목표 ID는 각각 중복될 수 없습니다.');
  const known = (key: string, value: unknown) => Object.hasOwn(env.initialState, key) && typeof env.initialState[key] === typeof value;
  for (const action of env.actions) {
    if (action.actorIds.some(actor => !v.characters.some(character => character.id === actor))) fail(`알 수 없는 행동 수행자: ${action.id}`);
    if (!Object.keys(action.effects).length || Object.entries(action.effects).some(([key, value]) => !known(key, value))) fail(`행동 효과는 초기 상태에 선언된 키와 자료형만 사용하세요: ${action.id}`);
  }
  for (const condition of [...env.actions.flatMap(a => a.conditions), ...env.goals.flatMap(g => g.conditions)]) {
    if (!known(condition.key, condition.value) || (['gte', 'lte'].includes(condition.op) && typeof condition.value !== 'number')) fail(`잘못된 상태 조건: ${condition.key}`);
  }
});
export const experimentSchema = z.object({
  schemaVersion: z.literal(1), name: z.string().min(1), scenario: scenarioSchema,
  variants: z.array(z.object({
    id, label: z.string().min(1), model: z.string().optional(), effort: z.string().optional(),
    dialoguePromptVersion: z.enum(DIALOGUE_PROMPT_VERSIONS).optional(),
    characterPerformanceVersion: z.enum(performanceVersions).optional(),
    worldPromptVersion: z.enum(WORLD_PROMPT_VERSIONS).optional(),
    stopOnSilence: z.boolean().optional(),
    memoryMode: z.enum(['initial_only', 'reinject_on_speech']).default('initial_only'),
    deliveryMode: z.enum(['batched_on_turn', 'per_utterance']).default('batched_on_turn'),
    turnPolicy: z.enum(['round_robin', 'director']).default('round_robin'),
    environmentMode: z.enum(['off', 'rules', 'ai', 'ai_spatial']).optional(),
    eventGeneration: z.boolean().optional(),
  })).min(1).max(100),
  repetitions: z.number().int().min(1).max(100).default(1),
  maxUtterances: z.number().int().min(1).max(100_000).default(60),
  concurrentRuns: z.number().int().min(1).max(16).default(2),
  maxConcurrentCalls: z.number().int().min(1).max(32).default(2),
  timeoutMs: z.number().int().min(1000).max(3_600_000).default(300_000),
  evaluation: z.object({ enabled: z.boolean().default(true), interval: z.number().int().min(1).default(10),
    model: z.string().min(1), effort: z.string().min(1), contextCharacters: z.number().int().min(1000).max(500_000).default(100_000),
    repetitionWindow: z.number().int().min(1).max(100).default(12),
    repetitionThreshold: z.number().min(0.1).max(1).default(0.72),
    repetitionMinChars: z.number().int().min(3).max(1000).default(20),
  }),
  director: modelConfig,
  worldEngine: modelConfig.optional(),
  eventGenerator: eventGeneratorSchema.optional(),
  scheduledEvents: z.array(z.object({ afterUtterance: z.number().int().min(0), text: text.min(1),
    observation: text.trim().min(1).optional(), audience: audienceSchema.optional() })).default([]),
}).superRefine((v, c) => {
  if (new Set(v.variants.map(x => x.id)).size !== v.variants.length)
    c.addIssue({ code: 'custom', message: '실험 조건 ID는 중복될 수 없습니다.' });
  if (v.variants.length * v.repetitions > 500)
    c.addIssue({ code: 'custom', message: '한 실험은 최대 500개 묶음을 생성할 수 있습니다.' });
  if (v.variants.some(x => ['ai', 'ai_spatial'].includes(x.environmentMode ?? '')) && !v.worldEngine)
    c.addIssue({ code: 'custom', path: ['worldEngine'], message: 'AI 세계 엔진의 모델과 추론 강도를 지정하세요.' });
  if (v.variants.some(x => x.environmentMode === 'ai_spatial') && !v.scenario.spatial)
    c.addIssue({ code: 'custom', path: ['scenario', 'spatial'], message: '분산 공간의 장소·통로·NPC 시작 위치를 지정하세요.' });
  if (v.scenario.clockEvents?.length && v.variants.some(x => !['ai','ai_spatial'].includes(x.environmentMode ?? '') ||
    (x.environmentMode !== 'ai_spatial' && v.scenario.clockEvents!.some(e => e.locationIds))))
    c.addIssue({ code:'custom', path:['scenario','clockEvents'], message:'시각 사건에는 세계 시계가, 장소별 사건에는 분산 공간이 필요합니다.' });
  if (v.variants.some(x => x.eventGeneration) && !v.eventGenerator)
    c.addIssue({ code: 'custom', path: ['eventGenerator'], message: '상황 발생 엔진의 모델·빈도·허용 범위를 지정하세요.' });
  if (v.variants.some(x => x.eventGeneration) && v.eventGenerator && !v.eventGenerator.allowedEvents.trim())
    c.addIssue({ code: 'custom', path: ['eventGenerator', 'allowedEvents'], message: '상황 발생 엔진을 사용하려면 ‘발생 가능한 사건 범위’를 입력하세요.' });
  if (v.variants.some(x => x.eventGeneration && !['ai', 'ai_spatial'].includes(x.environmentMode ?? '')))
    c.addIssue({ code: 'custom', message: '상황 발생 엔진은 AI 세계 엔진 환경에서만 사용할 수 있습니다.' });
  if (v.variants.some(x => x.environmentMode === 'rules') && !v.scenario.environment?.enabled)
    c.addIssue({ code: 'custom', path: ['scenario', 'environment'], message: '규칙 환경 모드에는 활성화된 환경 규칙이 필요합니다.' });
  for (const [i, e] of v.scheduledEvents.entries()) if (e.audience) {
    const a = e.audience, issue = (message: string) => c.addIssue({ code: 'custom', path: ['scheduledEvents', i, 'audience'], message });
    if (a.scope === 'locations' && (v.variants.some(x => x.environmentMode !== 'ai_spatial') || !a.locationIds.length || a.npcIds.length)) issue('장소별 상황은 분산 공간 조건에만 사용하고 장소 ID를 지정하세요.');
    if (a.scope === 'npcs' && (!a.npcIds.length || a.locationIds.length) || ['all', 'none'].includes(a.scope) && (a.npcIds.length || a.locationIds.length)) issue('수신 범위에 해당하는 배열만 채우세요.');
    if (new Set(a.npcIds).size !== a.npcIds.length || new Set(a.locationIds).size !== a.locationIds.length || a.npcIds.some(id => !v.scenario.characters.some(c => c.id === id)) || a.locationIds.some(id => !v.scenario.spatial?.locations.some(l => l.id === id))) issue('알 수 없거나 중복된 수신 대상입니다.');
  }
});
export type ExperimentSpec = z.infer<typeof experimentSchema>;
export type Scenario = z.infer<typeof scenarioSchema>;
export type Character = z.infer<typeof characterSchema>;
export type ModelConfig = z.infer<typeof modelConfig>;
export type Variant = ExperimentSpec['variants'][number];
// Silence is a valid choice. Requiring a gesture here encourages filler and
// pauses otherwise valid conversations when the model chooses to just listen.
export const speechSchema = z.object({ speech: z.string(), action: z.string(), actionId: z.string().nullable().optional() });
export const progressSpeechSchema = z.object({ speech: z.string(), action: z.string(), actionId: z.string().nullable() });
export const receiveSchema = z.object({ received: z.literal(true) });
export const situationResolutionSchema = worldOutputSchema.extend({ proposalDecision: z.object({ accepted: z.boolean(), reason: z.string().min(1) }) });
export const directorSchema = z.object({ speakerId: z.string(), reason: z.string() });
export const categories = ['personality', 'speech_style', 'behavior', 'memory', 'knowledge', 'world_contradiction', 'world_expansion', 'repetition', 'goal_stagnation'] as const;
export const evaluationSchema = z.object({ findings: z.array(z.object({
  utteranceId: z.string(), category: z.enum(categories), severity: z.enum(['low', 'medium', 'high']),
  verdict: z.enum(['issue', 'uncertain']), quote: z.string(), reference: z.string(), explanation: z.string(),
})), summary: z.string() });
export const outputSchemas = {
  speech: z.toJSONSchema(z.object({ speech: z.string(), action: z.string() })),
  progressSpeech: z.toJSONSchema(progressSpeechSchema),
  receive: z.toJSONSchema(receiveSchema), director: z.toJSONSchema(directorSchema), evaluation: z.toJSONSchema(evaluationSchema),
  environment: z.toJSONSchema(worldOutputSchema),
  situationResolution: z.toJSONSchema(situationResolutionSchema),
  spatialSpeech: z.toJSONSchema(spatialSpeechSchema), spatialPlan: z.toJSONSchema(spatialPlanSchema),
  spatialResolution: z.toJSONSchema(spatialResolutionSchema), event_generation: z.toJSONSchema(eventProposalSchema),
};
export function environmentMode(spec: ExperimentSpec, variant?: Variant) {
  return variant?.environmentMode ?? (spec.scenario.environment?.enabled ? 'rules' : 'off');
}
export const isAiEnvironment = (spec: ExperimentSpec, variant?: Variant) => ['ai', 'ai_spatial'].includes(environmentMode(spec, variant));
export function responseValidator(kind: string, outputType?: unknown) {
  if (kind === 'speech' && outputType === 'spatialSpeech') return spatialSpeechSchema;
  if (kind === 'environment' && outputType === 'spatialPlan') return spatialPlanSchema;
  if (kind === 'environment' && outputType === 'spatialResolution') return spatialResolutionSchema;
  if (kind === 'environment' && outputType === 'situationResolution') return situationResolutionSchema;
  const schemas: Record<string, z.ZodType> = { speech: speechSchema, receive: receiveSchema, director: directorSchema, evaluation: evaluationSchema, environment: worldOutputSchema, event_generation: eventProposalSchema };
  if (!schemas[kind]) throw new Error(`알 수 없는 호출 종류: ${kind}`);
  return schemas[kind];
}
