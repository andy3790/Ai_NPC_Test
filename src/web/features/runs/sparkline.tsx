import type { InvocationMetrics } from '../../../shared/types.js';

export function Sparkline({ calls }: { calls: InvocationMetrics[] }) {
  const values = calls.filter(c => c.status === 'completed' && c.durationMs !== null).slice(-30).map(c => c.durationMs!);
  const max = Math.max(1, ...values); const points = values.map((v, i) => `${i / Math.max(1, values.length - 1) * 240},${55 - v / max * 45}`).join(' ');
  return <svg className="sparkline" viewBox="0 0 240 65" role="img" aria-label="최근 호출 소요 시간"><path d="M0 55H240M0 30H240" stroke="#e8ece8" strokeDasharray="3 4"/>{values.length > 0 && <polyline points={points} fill="none" stroke="#288166" strokeWidth="2"/>}</svg>;
}
