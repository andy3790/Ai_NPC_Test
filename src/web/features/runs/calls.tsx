import { Fragment, useState } from 'react';
import type { InvocationMetrics } from '../../../shared/types.js';
import { estimateCost } from '../../../core/pricing.js';
import { kinds, number, time, usd } from '../../shared/formatters.js';
import { Badge } from '../../shared/ui.js';

const costNotes = {
  estimated: '', assumed: '일부 요금 조건 가정', missing_rate: '공식 단가 미등록',
  missing_usage: '사용량 미계측', pending: '계측 대기', not_applicable: '',
};

export function Calls({ calls, adapter }: { calls: InvocationMetrics[]; adapter: string }) {
  const [expanded, setExpanded] = useState('');
  const [filter, setFilter] = useState('all');
  return <div>
    <div className="table-filter">
      <select aria-label="호출 종류 필터" value={filter} onChange={e => setFilter(e.target.value)}>
        <option value="all">모든 호출</option>
        {Object.entries(kinds).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select>
      <span>행을 선택하면 원본 입력과 출력을 확인합니다.</span>
    </div>
    <div className="table-wrap"><table>
      <thead><tr><th>종류 / NPC</th><th>모델 · 추론</th><th>입력 / 출력</th><th>전체 토큰</th><th>API 환산 비용 (USD)</th><th>소요 시간</th><th>상태</th></tr></thead>
      <tbody>{calls.filter(call => filter === 'all' || call.kind === filter).map(call => {
        const cost = estimateCost(call, adapter);
        return <Fragment key={call.id}>
          <tr className="clickable" onClick={() => setExpanded(expanded === call.id ? '' : call.id)}>
            <td>{kinds[call.kind]}<small>{call.characterId ?? `시도 ${call.attempt}`}</small></td>
            <td>{cost.model}<small>{call.effort}{cost.model !== call.model ? ` · 요청 ${call.model}` : ''}</small></td>
            <td>{number(call.usage.inputTokens)} / {number(call.usage.outputTokens)}</td>
            <td>{number(call.usage.totalTokens)}</td>
            <td>{usd(cost.usd)}{costNotes[cost.status] && <small>{costNotes[cost.status]}</small>}</td>
            <td>{time(call.durationMs)}</td><td><Badge status={call.status}/></td>
          </tr>
          {expanded === call.id && <tr><td colSpan={7}><div className="call-detail">
            <p>대기 {time(call.queueMs)} · 첫 출력 {time(call.firstOutputMs)} · 캐시 입력 {number(call.usage.cachedInputTokens)} · 캐시 쓰기 {number(call.usage.cacheWriteInputTokens)} · 추론 출력 {number(call.usage.reasoningOutputTokens)}</p>
            <small>{call.usageStatus} · {call.id}</small>
            {call.error && <p className="red">{call.error}</p>}
            <h4>입력</h4><pre>{call.input}</pre><h4>출력</h4><pre>{call.output || '아직 출력이 없습니다.'}</pre>
          </div></td></tr>}
        </Fragment>;
      })}</tbody>
    </table></div>
  </div>;
}
