import type { ExperimentSpec, ModelConfig, Variant, State, EnvironmentSpec } from './schema.js';
import type { WorldEvent, WorldState } from './world-schema.js';
import type { Audience, EventGeneratorState, SpatialSpeech } from './spatial-schema.js';
export interface ModelInfo { id: string; name: string; efforts: string[]; defaultEffort: string; isDefault?: boolean }
// Only non-secret references are persisted. API key values live in server memory.
export type ApiCredential = { source: 'environment' } | { source: 'browser'; keyId: string; ownerId: string };
export interface ApiKeyStatus { source: 'browser' | 'environment' | 'missing'; configured: boolean; environmentAvailable: boolean }
export type CallKind = 'speech' | 'receive' | 'director' | 'evaluation' | 'environment' | 'event_generation';
export type RunStatus = 'queued' | 'running' | 'paused' | 'completed' | 'stopped';
export interface NpcSession { id: string; characterId: string; threadId: string; config: ModelConfig; instructions: string }
export interface ActionResolution { actionId: string; sourceUtteranceId: string; speechIndex: number; actorId: string; before: State; after: State }
export interface Utterance { id: string; runId: string; sequence: number; speechIndex: number | null; speakerId: string; speakerName: string; kind: 'speech' | 'event'; speech: string; action: string; createdAt: string; invocationId: string | null; deliveryCompletedAt: string | null; deliveryMs: number | null; actionId?: string | null; resolution?: ActionResolution;
  worldEvent?: WorldEvent & { sourceUtteranceId: string | null; virtualSeconds: number; audience?: Audience; proposalId?: string | null };
  perception?: { locationId: string | null; virtualSeconds: number; speechRecipientIds: string[]; actionRecipientIds: string[]; audience?: Audience };
  spatialIntent?: SpatialSpeech; knownUtteranceIds?: string[];
}
export interface DeliveryReceipt { id: string; runId: string; utteranceId: string; characterId: string; status: 'pending' | 'processing' | 'delivered'; invocationId: string | null; deliveredAt: string | null }
export interface TokenUsage { inputTokens: number | null; cachedInputTokens: number | null; cacheWriteInputTokens: number | null; outputTokens: number | null; reasoningOutputTokens: number | null; totalTokens: number | null }
export interface CostSummary { usd: number | null; unpricedCalls: number; assumedCalls: number; pricingDate: string }
export interface InvocationSummary {
  calls: number; failed: number; pendingCalls: number; missingUsage: number; tokens: TokenUsage;
  cost: CostSummary;
  durationSumMs: number; medianMs: number | null; p95Ms: number | null; failureRate: number | null;
}
export interface RepetitionSummary {
  algorithm: string; window: number; threshold: number; minChars: number; totalSpeeches: number;
  eligibleSpeeches: number; repeatedSpeeches: number; rate: number | null;
  matches: { utteranceId: string; speechIndex: number; previousUtteranceId: string; previousSpeechIndex: number; similarity: number }[];
}
export interface ProgressionSummary {
  state: State; usedActionIds: string[];
  goals: (EnvironmentSpec['goals'][number] & { achieved: boolean; firstAchievedAtSpeech: number | null })[];
  achievedGoals: number; totalGoals: number; allGoalsAchieved: boolean; successfulActions: number;
  lastProgressSpeech: number; stalledSpeechCount: number;
}
export interface QualitySummary {
  repetition: RepetitionSummary;
  semanticRepetition: { flaggedSpeeches: number; evaluatedSpeeches: number; rate: number | null };
  progression: ProgressionSummary | null;
}
export interface RunSummary extends InvocationSummary {
  speechCount: number; pendingReceipts: number; byKind: Record<CallKind, InvocationSummary>;
  tokensPerSpeech: number | null; evaluatedUtterances: number; evaluationFailures: number;
  firstIssue: number | null; issueRate: number | null; categories: Record<string, number>; confirmedIssues: number;
  quality: QualitySummary; elapsedMs: number; activeMs: number; timingComplete: boolean; pausedMs: number;
}
export interface InvocationMetrics {
  id: string; experimentId: string; runId: string; variantId: string; repetition: number; characterId: string | null;
  kind: CallKind; operationKey: string; attempt: number; retryOf: string | null; threadId: string; turnId: string | null;
  sourceUtteranceId: string | null; utteranceId: string | null; model: string; effort: string; actualModel: string | null;
  deliveryMode: Variant['deliveryMode']; memoryMode: Variant['memoryMode'];
  environmentMode?: Variant['environmentMode'];
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
  promptVersion?: string;
  apiCredential?: ApiCredential;
  worldState?: WorldState;
  eventGeneratorState?: EventGeneratorState;
  roundRobinCursor?: number;
  completionReason?: 'goals_achieved' | 'utterance_limit';
}
export interface RawEvent { id: number; runId: string; invocationId: string | null; receivedAt: string; method: string; params: unknown }
export interface RunHistory { readOnly: boolean; kind: 'current' | 'archive'; locations: string[]; archivedAt?: string }
export interface RunNpcConfig { characterId: string; name: string; model: string; effort: string }
export type RunListItem = Omit<Run, 'spec' | 'sessions' | 'helperSessions' | 'worldState' | 'eventGeneratorState'> & {
  maxUtterances: number; summary: RunSummary; history?: RunHistory | null;
  scenario: { id: string; name: string; characterCount: number }; npcConfigs: RunNpcConfig[];
  environmentMode?: Variant['environmentMode'];
};
export interface RunDeletionPlan {
  runId: string; name: string; token: string; allowed: boolean; blockers: string[];
  targets: { path: string; kind: 'database' | 'archive' | 'export' | 'session' }[];
  speechCount: number; invocationCount: number;
}
export interface BulkRunDeletionPlan {
  selectedCount: number; deletableCount: number; token: string;
  entries: { runId: string; plan: RunDeletionPlan | null; error: string | null }[];
}
export interface BulkRunDeletionResult {
  results: { runId: string; status: 'deleted' | 'blocked' | 'failed'; error: string | null }[];
}
export interface RunRecords { run: Run; utterances: Utterance[]; receipts: DeliveryReceipt[]; invocations: InvocationMetrics[]; findings: EvaluationFinding[]; evaluations: EvaluationRecord[] }
export interface RunDetail extends RunRecords { summary: RunSummary; history?: RunHistory | null }
