import { z } from 'zod';
import type { SpatialState } from './spatial-schema.js';

const id = z.string().regex(/^[a-zA-Z0-9_-]+$/).max(100);
const text = z.string().min(1).max(5000);
export const worldFactSchema = z.object({
  id, text, scope: z.enum(['environment', 'npc_physical']).describe('environment: 사물·환경의 확인된 상태. npc_physical: 특정 NPC의 신체 상태. 주장·속마음은 사실이 아니다.'), npcId: id.nullable(),
});
export const worldEventSchema = z.object({
  type: z.enum(['observation', 'physical_effect', 'actor_result', 'external_signal'])
    .describe('observation: 사물·환경의 새 관찰. physical_effect: NPC에게 생긴 비자발적 신체 결과(npcId 필수). actor_result: 현재 화자가 선택한 행동의 실제 결과(npcId와 정확한 evidence 필수). external_signal: 화면·메시지 등 외부 응답.'),
  text: text.describe('이미 받은 대사·행동의 요약이 아닌 새 관찰이나 결과만 쓴다.'),
  npcId: id.nullable().describe('physical_effect는 영향받은 NPC, actor_result는 현재 화자. observation/external_signal은 null.'),
  evidence: text.nullable().describe('actor_result는 현재 화자의 action 또는 speech에서 실제 시도를 그대로 인용한다. 다른 유형은 null.'), processId: id.nullable(),
});
// All output properties are required for strict structured-output providers.
// Empty arrays mean no change; a silent tick is a valid world-engine result.
export const worldOutputSchema = z.object({
  elapsedSeconds: z.number().finite().nonnegative(),
  facts: z.array(worldFactSchema).max(100), forgetFactIds: z.array(id).max(100),
  processes: z.array(z.object({ id, description: text, readyAtSeconds: z.number().finite().nonnegative().describe('장면 시작 이후 절대 가상 초. 이 시각 전에는 completed로 끝낼 수 없다.'), requestNpcIds: z.array(id).max(30) })).max(100),
  finishProcesses: z.array(z.object({ id, outcome: z.enum(['completed', 'cancelled'])
    .describe('completed는 현재 가상 시간이 readyAtSeconds 이상일 때만 가능. 사전 조치로 예정 사건이 필요 없어졌으면 cancelled.'), reason: text })).max(100),
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
