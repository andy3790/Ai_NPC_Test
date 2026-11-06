import { z } from 'zod';
import { worldEventSchema, worldFactSchema } from './world-schema.js';

const id = z.string().regex(/^[a-zA-Z0-9_-]+$/).min(1).max(100);
const text = z.string().max(100_000);
export const spatialSchema = z.object({
  locations: z.array(z.object({ id, name: z.string().min(1).max(100), description: text, initialSituation: text.default('') })).min(2).max(100),
  connections: z.array(z.object({ id, from: id, to: id, bidirectional: z.boolean().default(true), description: text.default('') })).max(500).default([]),
  initialPositions: z.array(z.object({ npcId: id, locationId: id })).min(2).max(30),
  channels: z.array(z.object({ id, name: z.string().min(1).max(100), memberNpcIds: z.array(id).min(2).max(30), description: text.default('') })).max(100).default([]),
});
export type SpatialSpec = z.infer<typeof spatialSchema>;
export const communicationSchema = z.object({ mode: z.enum(['local', 'whisper', 'channel', 'none']), targetNpcIds: z.array(id).max(30), channelId: id.nullable() });
export const spatialSpeechSchema = z.object({
  speech: z.string(), action: z.string(), communication: communicationSchema,
  moveToLocationId: id.nullable(), activityChoice: z.enum(['start', 'continue', 'cancel']),
}).refine(v => !!(v.speech.trim() || v.action.trim() || v.activityChoice === 'cancel'), '발언·행동 또는 진행 중 행동의 중단 선택이 필요합니다.');
export type SpatialSpeech = z.infer<typeof spatialSpeechSchema>;
export const spatialPlanSchema = z.object({ plans: z.array(z.object({
  utteranceId: id, speechSeconds: z.number().finite().nonnegative(), actionSeconds: z.number().finite().nonnegative(),
  reactionNpcIds: z.array(id).max(30), movementStarts: z.boolean(),
})).max(30) });
export const audienceSchema = z.object({ scope: z.enum(['locations', 'npcs', 'all', 'none']), locationIds: z.array(id).max(100), npcIds: z.array(id).max(30) });
export type Audience = z.infer<typeof audienceSchema>;
export const spatialFactSchema = worldFactSchema.extend({ locationId: id.nullable(), visibility: z.enum(['visible', 'hidden']) });
export const spatialEventSchema = worldEventSchema.extend({
  sourceUtteranceId: id.nullable(), proposalId: id.nullable(), audience: audienceSchema,
});
export const spatialResolutionSchema = z.object({
  completedActivities: z.array(z.object({ id, outcome: z.enum(['completed', 'failed']), reason: z.string().min(1).max(5000) })).max(60),
  activityUpdates: z.array(z.object({ id, readyAtSeconds: z.number().finite().nonnegative(), requestNpcIds: z.array(id).max(30), reason: z.string().min(1).max(5000) })).max(60),
  movements: z.array(z.object({ npcId: id, activityId: id.nullable(), toLocationId: id, kind: z.enum(['requested', 'forced']) })).max(30),
  facts: z.array(spatialFactSchema).max(100), forgetFactIds: z.array(id).max(100),
  processes: z.array(z.object({ id, description: z.string().min(1).max(5000), readyAtSeconds: z.number().finite().nonnegative(),
    requestNpcIds: z.array(id).max(30), locationIds: z.array(id).max(100) })).max(100),
  finishProcesses: z.array(z.object({ id, outcome: z.enum(['completed', 'cancelled']), reason: z.string().min(1).max(5000) })).max(100),
  events: z.array(spatialEventSchema).max(100),
  proposalDecision: z.object({ accepted: z.boolean(), reason: z.string().min(1).max(5000) }).nullable(),
});
export type SpatialResolution = z.infer<typeof spatialResolutionSchema>;

export const eventGeneratorSchema = z.object({
  model: z.string().min(1), effort: z.string().min(1),
  intervalSeconds: z.number().finite().positive().max(31_536_000).default(30),
  minGapSeconds: z.number().finite().nonnegative().max(31_536_000).default(60),
  maxProposals: z.number().int().min(1).max(1000).default(10),
  maxChecks: z.number().int().min(1).max(10_000).default(30),
  maxSeverity: z.enum(['low', 'medium', 'high']).default('medium'),
  // An unused generator may retain its empty draft. The experiment validates
  // the required event scope whenever any variant enables generation.
  allowedEvents: text, forbiddenEvents: text.default(''),
});
export const eventProposalSchema = z.object({ proposal: z.object({ title: z.string().min(1).max(200),
  description: z.string().min(1).max(5000), locationIds: z.array(id).max(100), severity: z.enum(['low', 'medium', 'high']),
}).nullable() });
export type SituationProposal = NonNullable<z.infer<typeof eventProposalSchema>['proposal']> & { id: string; invocationId: string; virtualSeconds: number; status: 'proposed' | 'accepted' | 'rejected'; reason: string | null };
export interface EventGeneratorState { checks: number; nextCheckAtSeconds: number; lastAcceptedAtSeconds: number | null; proposals: SituationProposal[] }

export interface SpatialActivity {
  id: string; npcId: string; sourceUtteranceId: string; kind: 'action' | 'reaction';
  status: 'pending' | 'completed' | 'failed' | 'cancelled'; reason: string | null;
  startedAtSeconds: number; readyAtSeconds: number; speakingUntilSeconds: number; finishedAtSeconds: number | null;
  locationId: string | null; moveToLocationId: string | null;
  waitingNpcIds: string[]; offeredNpcIds: string[];
}
export interface SpatialPosition { npcId: string; locationId: string | null; transit: { from: string; to: string; connectionId: string; activityId: string } | null }
export interface SpatialCycle {
  id: number; atSeconds: number; stage: 'deciding' | 'planning';
  npcIds: string[]; utteranceIds: string[];
}
export interface SpatialState {
  positions: SpatialPosition[]; activities: SpatialActivity[]; cycle: SpatialCycle | null; nextCycle: number;
  lastSelectedNpcIds: string[]; pendingResolution: { id: number; atSeconds: number; proposalId: string | null } | null;
  nextResolution: number;
  lastResolvedSequence?: number;
}
