import type { ModelConfig } from '../shared/schema.js';
import type { ModelInfo, TokenUsage } from '../shared/types.js';
export interface AdapterEvent { method: string; params: any }
export interface TurnRequest { threadId: string; config: ModelConfig; input: string; outputSchema: object; clientMessageId: string; timeoutMs: number }
export interface TurnResult { turnId: string; output: string; status: 'completed' | 'failed' | 'cancelled' | 'uncertain'; error?: string }
export interface Adapter {
  name: string; version: string;
  models(): Promise<ModelInfo[]>;
  createSession(config: ModelConfig, instructions: string, cwd: string): Promise<string>;
  resumeSession(threadId: string): Promise<void>;
  turn(request: TurnRequest, onEvent: (event: AdapterEvent) => void, signal?: AbortSignal): Promise<TurnResult>;
  reconcile(threadId: string, turnId: string | null, clientMessageId: string): Promise<TurnResult | null>;
  baseline(threadId: string): TokenUsage | null;
  close(): Promise<void>;
}
