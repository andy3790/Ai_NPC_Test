import type { RunListItem } from '../../../shared/types.js';
import { number, usd } from '../../shared/formatters.js';
import { Stat } from '../../shared/ui.js';

export function RunStatistics({ runs }: { runs: RunListItem[] }) {
  let totalCost: number | null = null;
  let unpricedCalls = 0;
  let assumedCalls = 0;
  for (const { summary } of runs) {
    const cost = summary.cost;
    if (!cost) continue;
    if (cost.usd !== null) totalCost = (totalCost ?? 0) + cost.usd;
    unpricedCalls += cost.unpricedCalls;
    assumedCalls += cost.assumedCalls;
  }
  return <div className="stats-row">
          <Stat label="표시된 대화 묶음" value={number(runs.length)} note={`${runs.filter(r => r.status === 'completed').length}개 완료 · 선택한 필터 기준`}/>
          <Stat label="공개 발화" value={number(runs.reduce((s, r) => s + r.summary.speechCount, 0))} note="NPC 발언만 · 엔진·수신·평가 제외"/>
          <Stat label="확인된 전체 토큰" value={runs.length ? number(runs.reduce((s, r) => s + (r.summary.tokens.totalTokens ?? 0), 0)) : '—'} note={<>
            <span className="stat-cost">API 환산 비용 <b>{usd(totalCost)}</b></span>
            모든 호출 포함 · 미계측 {runs.reduce((s, r) => s + r.summary.missingUsage, 0)}건
            {unpricedCalls > 0 && ` · 비용 미산정 ${unpricedCalls}건`}
            {assumedCalls > 0 && ` · 가정 적용 ${assumedCalls}건`}
          </>}/>
          <Stat label="검토할 지적" value={number(runs.reduce((s, r) => s + Object.values(r.summary.categories).reduce((a, b) => a + b, 0), 0))} note="AI 의심 결과 · 기각 항목 제외" accent/>
        </div>;
}
