import { z } from 'zod';
import type { SpatialState } from './spatial-schema.js';

const id = z.string().regex(/^[a-zA-Z0-9_-]+$/).max(100);
const text = z.string().min(1).max(5000);
export const worldFactSchema = z.object({
  id, text, scope: z.enum(['environment', 'npc_physical']), npcId: id.nullable(),
});
export const worldEventSchema = z.object({
  type: z.enum(['observation', 'physical_effect', 'actor_result', 'external_signal']),
  text, npcId: id.nullable(), evidence: text.nullable(), processId: id.nullable(),
});
// All output properties are required for strict structured-output providers.
// Empty arrays mean no change; a silent tick is a valid world-engine result.
export const worldOutputSchema = z.object({
  elapsedSeconds: z.number().finite().nonnegative(),
  facts: z.array(worldFactSchema).max(100), forgetFactIds: z.array(id).max(100),
  processes: z.array(z.object({ id, description: text, readyAtSeconds: z.number().finite().nonnegative(), requestNpcIds: z.array(id).max(30) })).max(100),
  finishProcesses: z.array(z.object({ id, outcome: z.enum(['completed', 'cancelled']), reason: text })).max(100),
  events: z.array(worldEventSchema).max(50),
});
export type WorldOutput = z.infer<typeof worldOutputSchema>;
export type WorldFact = z.infer<typeof worldFactSchema> & { locationId?: string | null; visibility?: 'visible' | 'hidden' };
export type WorldEvent = z.infer<typeof worldEventSchema>;
export interface WorldProcess {
  id: string; description: string; readyAtSeconds: number; createdAtSeconds: number;
  sourceUtteranceId: string; waitingNpcIds: string[]; offeredNpcIds: string[];
  status: 'pending' | 'completed' | 'cancelled'; finishedAtSeconds: number | null; reason: string | null;
  locationIds?: string[];
}
export interface WorldState {
  virtualSeconds: number; facts: WorldFact[]; processes: WorldProcess[];
  processedSpeechId: string | null; processedSequence: number; processedSpeechCount: number;
  spatial?: SpatialState;
}
