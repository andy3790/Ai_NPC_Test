import type { Store } from './store.js';
import type { ModelConfig } from '../shared/schema.js';
import type { Audience } from '../shared/spatial-schema.js';
import type { CallKind, InvocationMetrics, NpcSession, Run, Utterance } from '../shared/types.js';
import type { directorPrompt } from './director.js';

export interface SimulationHost {
  id: string; store: Store; run(): Run; closing(): boolean;
  helper(key: string, config: ModelConfig, instructions: string): Promise<NpcSession>;
  direct(key: string, operationKey: string, prompt: ReturnType<typeof directorPrompt>): Promise<InvocationMetrics>;
  invoke(kind: CallKind, session: NpcSession, key: string, input: string, metadata?: Record<string, unknown>): Promise<InvocationMetrics>;
  append(u: Utterance): void; flush(): Promise<void>; changed(): void;
  completeDelivery(u: Utterance): void;
  inject(text: string, audience?: Audience): void;
  evaluate(final: boolean): Promise<void>;
}
