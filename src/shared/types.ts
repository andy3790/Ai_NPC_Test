import type { ExperimentSpec, ModelConfig, Variant, State } from './schema.js';
export interface ModelInfo { id: string; name: string; efforts: string[]; defaultEffort: string; isDefault?: boolean }
export type CallKind = 'speech' | 'receive' | 'director' | 'evaluation';
export type RunStatus = 'queued' | 'running' | 'paused' | 'completed' | 'stopped';
export interface NpcSession { id: string; characterId: string; threadId: string; config: ModelConfig; instructions: string }
export interface ActionResolution { actionId: string; sourceUtteranceId: string; speechIndex: number; actorId: string; before: State; after: State }
export interface Utterance { id: string; runId: string; sequence: number; speechIndex: number | null; speakerId: string; speakerName: string; kind: 'speech' | 'event'; speech: string; action: string; createdAt: string; invocationId: string | null; deliveryCompletedAt: string | null; deliveryMs: number | null; actionId?: string | null; resolution?: ActionResolution }
export interface DeliveryReceipt { id: string; runId: string; utteranceId: string; characterId: string; status: 'pending' | 'processing' | 'delivered'; invocationId: string | null; deliveredAt: string | null }
export interface TokenUsage { inputTokens: number | null; cachedInputTokens: number | null; cacheWriteInputTokens: number | null; outputTokens: number | null; reasoningOutputTokens: number | null; totalTokens: number | null }
export interface InvocationMetrics {
  id: string; experimentId: string; runId: string; variantId: string; repetition: number; characterId: string | null;
  kind: CallKind; operationKey: string; attempt: number; retryOf: string | null; threadId: string; turnId: string | null;
  sourceUtteranceId: string | null; utteranceId: string | null; model: string; effort: string; actualModel: string | null;
  deliveryMode: Variant['deliveryMode']; memoryMode: Variant['memoryMode'];
  queuedAt: string; startedAt: string | null; firstOutputAt: string | null; completedAt: string | null;
  queueMs: number | null; firstOutputMs: number | null; durationMs: number | null;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'uncertain';
  usage: TokenUsage; usageStatus: string; input: string; output: string; error: string | null; metadata: Record<string, unknown>;
}
export interface EvaluationFinding { id: string; runId: string; evaluationId: string; utteranceId: string; category: string; severity: string; verdict: string; quote: string; reference: string; explanation: string; review: 'unreviewed' | 'confirmed' | 'dismissed'; note: string }
export interface EvaluationRecord { id: string; runId: string; from: number; to: number; status: 'completed' | 'failed'; contextTruncated: boolean; summary: string; invocationId: string | null; error: string | null; quality?: Record<string, unknown> }
export interface Run {
  id: string; experimentId: string; name: string; variant: Variant; repetition: number; spec: ExperimentSpec; snapshotHash: string;
  status: RunStatus; error: string | null; createdAt: string; startedAt: string | null; completedAt: string | null;
  activeMs: number; pausedMs: number; pausedAt: string | null; timingComplete: boolean; sessions: Record<string, NpcSession>;
  helperSessions: Record<string, NpcSession>; lastSpeakerId: string | null; nextSpeakerId: string | null;
  evaluatedThrough: number; appliedEvents: number[]; stepRemaining: number | null; pauseRequested: boolean;
  revisions: number; adapter: string; appVersion: string; cliVersion: string;
  completionReason?: 'goals_achieved' | 'utterance_limit';
}
export interface RawEvent { id: number; runId: string; invocationId: string | null; receivedAt: string; method: string; params: unknown }
export interface RunDetail { run: Run; utterances: Utterance[]; receipts: DeliveryReceipt[]; invocations: InvocationMetrics[]; findings: EvaluationFinding[]; evaluations: EvaluationRecord[]; summary: Record<string, any> }
