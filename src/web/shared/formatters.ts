import type { CostSummary } from '../../shared/types.js';

export const delivery: Record<string, string> = { batched_on_turn: '차례에 모아 전달', per_utterance: '매 발화마다 전달' };
export const memory: Record<string, string> = { initial_only: '초기 설정 유지', reinject_on_speech: '발화 전 재주입' };
export const providers: Record<string, string> = { codex: 'Codex CLI', openai: 'OpenAI API', mock: '모의 엔진' };
export const date = (s: string) => new Date(s).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
export const states: Record<string, string> = { queued: '대기 중', running: '실행 중', paused: '일시정지', completed: '완료', stopped: '중단', failed: '실패', cancelled: '취소', uncertain: '확인 필요' };
export const kinds: Record<string, string> = { speech: 'NPC 발화·행동', receive: '수신 처리', director: '진행자', evaluation: '평가', environment: '세계 엔진', event_generation: '상황 발생' };
export const environmentModes: Record<string, string> = { off: '대화만', rules: '사전 정의 규칙', ai: 'AI 세계 엔진', ai_spatial: 'AI 분산 공간' };
export const categoryNames: Record<string, string> = { personality: '성격·가치관', speech_style: '말투', behavior: '행동', memory: '기억', knowledge: '지식 범위', world_contradiction: '설정 모순', world_expansion: '세계관 확대', repetition: '의미 반복', goal_stagnation: '목표 진행 정체' };
export const number = (n: number | null | undefined) => n === null || n === undefined ? '—' : new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 1 }).format(n);
export const time = (n: number | null | undefined) => n === null || n === undefined ? '—' : n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(1)} s`;
export const stamp = (s: string) => new Date(s).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
export const percent = (n: number | null | undefined) => n === null || n === undefined ? '판단 자료 없음' : `${number(n * 100)}%`;
export const callKinds = Object.entries(kinds) as [import('../../shared/types.js').CallKind, string][];
const usdFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 8 });
export const usd = (value: number | null | undefined) => value == null ? '—' : usdFormat.format(value);
export function costText(cost?: CostSummary) {
  const notes = [];
  if (cost?.unpricedCalls) notes.push(`미산정 ${cost.unpricedCalls}건`);
  if (cost?.assumedCalls) notes.push(`가정 적용 ${cost.assumedCalls}건`);
  return [usd(cost?.usd), ...notes].join(' · ');
}
