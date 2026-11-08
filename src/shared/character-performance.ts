import { z } from 'zod';

export const CHARACTER_PERFORMANCE = 'character-performance/3' as const;
export const performanceVersions = ['off', 'character-performance/1', 'character-performance/2', CHARACTER_PERFORMANCE] as const;
export type PerformanceVersion = Exclude<typeof performanceVersions[number], 'off'>;
// Only ways of performing a line are writable. No generated biography, facts,
// relationships, honorifics or free-text instructions enter persistent state.
export const attentionChoices = ['내 취향이나 불편', '바로 손댈 일', '말에서 빠진 대목', '상대가 감수할 몫', '다른 가능성', '눈앞의 작은 변화'] as const;
export const phrasingChoices = ['대답을 먼저 건넨다', '구체적인 한 대목부터 꺼낸다', '말을 하며 생각을 이어 간다', '상대의 한마디에 내 생각을 보탠다', '생각을 고르고 말을 건넨다'] as const;
export const performanceSchema = z.object({ attention: z.enum(attentionChoices), phrasing: z.enum(phrasingChoices) });
export type Performance = z.infer<typeof performanceSchema>;
export interface StoredPerformance {
  version: PerformanceVersion;
  choices?: Performance;
  source: 'profile' | 'unspecified' | 'fallback';
  invocationId: string;
}
