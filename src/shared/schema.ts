import { z } from 'zod';

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
  id, name: z.string().min(1).max(100), identity: text, personality: text,
  values: text.default(''), goals: text.default(''), relationships: text.default(''),
  memories: text.default(''), knowledge: text.default(''), unknowns: text.default(''),
  speechStyle: text, exampleDialogue: text.default(''), behaviors: text, taboos: text.default(''),
  model: z.string().optional(), effort: z.string().optional(),
});
export const scenarioSchema = z.object({
  id, name: z.string().min(1), world: text.min(1), situation: text.min(1),
  characters: z.array(characterSchema).min(2).max(30),
  defaults: modelConfig,
  environment: environmentSchema.optional(),
}).superRefine((v, c) => {
  if (new Set(v.characters.map(x => x.id)).size !== v.characters.length)
    c.addIssue({ code: 'custom', message: '캐릭터 ID는 중복될 수 없습니다.' });
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
    memoryMode: z.enum(['initial_only', 'reinject_on_speech']).default('initial_only'),
    deliveryMode: z.enum(['batched_on_turn', 'per_utterance']).default('batched_on_turn'),
    turnPolicy: z.enum(['round_robin', 'director']).default('round_robin'),
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
  scheduledEvents: z.array(z.object({ afterUtterance: z.number().int().min(0), text: text.min(1) })).default([]),
}).superRefine((v, c) => {
  if (new Set(v.variants.map(x => x.id)).size !== v.variants.length)
    c.addIssue({ code: 'custom', message: '실험 조건 ID는 중복될 수 없습니다.' });
  if (v.variants.length * v.repetitions > 500)
    c.addIssue({ code: 'custom', message: '한 실험은 최대 500개 묶음을 생성할 수 있습니다.' });
});
export type ExperimentSpec = z.infer<typeof experimentSchema>;
export type Scenario = z.infer<typeof scenarioSchema>;
export type Character = z.infer<typeof characterSchema>;
export type ModelConfig = z.infer<typeof modelConfig>;
export type Variant = ExperimentSpec['variants'][number];
export const speechSchema = z.object({ speech: z.string(), action: z.string(), actionId: z.string().nullable().optional() }).refine(v => !!(v.speech.trim() || v.action.trim()), '대사 또는 행동이 필요합니다.');
export const progressSpeechSchema = z.object({ speech: z.string(), action: z.string(), actionId: z.string().nullable() });
export const receiveSchema = z.object({ received: z.literal(true) });
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
};
