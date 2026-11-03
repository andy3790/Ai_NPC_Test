import { CodexAdapter } from './codex.js';
import { MockAdapter } from './mock.js';
import { OpenAIAdapter } from './openai.js';
import type { Adapter } from './types.js';

export function adapterName(options: { adapter?: string; mock?: boolean } = {}) {
  if (options.mock && options.adapter && options.adapter !== 'mock') throw new Error('--mock와 다른 --adapter를 함께 사용할 수 없습니다.');
  const name = options.mock ? 'mock' : options.adapter ?? process.env.NPC_LAB_ADAPTER ?? 'codex';
  if (!['codex', 'openai', 'mock'].includes(name)) throw new Error('어댑터는 codex, openai, mock 중에서 선택하세요.');
  return name;
}
export function createAdapter(name: string, directory: string): Adapter {
  if (name === 'codex') return new CodexAdapter(directory);
  if (name === 'openai') return new OpenAIAdapter(directory);
  if (name === 'mock') return new MockAdapter();
  throw new Error('지원하지 않는 어댑터');
}
