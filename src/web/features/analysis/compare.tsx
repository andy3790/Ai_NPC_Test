import { environmentMode } from '../../../shared/schema.js';
import type { RunDetail, RunListItem } from '../../../shared/types.js';
import { groupedMetrics } from '../../../core/metrics.js';
import { delivery, memory, providers, kinds, number, time, date, percent, costText, environmentModes } from '../../shared/formatters.js';

export function GroupedTable({ details }: { details: RunDetail[] }) {
  const rows = groupedMetrics(details.flatMap(d => d.invocations.map(c => ({ ...c, metadata: { ...c.metadata, adapter: d.run.adapter } }))));
  return <>
    <div className="section-heading"><h2>모델·추론별 집계</h2><span className="muted">선택한 묶음 · 호출 종류별 분리</span></div>
    <div className="panel table-wrap"><table>
      <thead><tr><th>요청 모델 / 추론</th><th>전달 / 기억 / 환경</th><th>종류</th><th>묶음 / 호출</th><th>토큰 합계 / 호출당</th><th>API 환산 비용 (USD)</th><th>중앙값 / P95</th><th>미계측 / 실패</th></tr></thead>
      <tbody>{rows.map((g, i) => <tr key={i}>
        <td>{g.model}<small>{g.effort} · {g.adapter}</small></td>
        <td>{delivery[g.deliveryMode]}<small>{memory[g.memoryMode]} · {environmentModes[g.environmentMode] ?? '이전 기록'}</small></td>
        <td>{kinds[g.kind]}</td><td>{g.runs} / {g.calls}</td>
        <td>{number(g.tokens.totalTokens)} / {number(g.tokensPerCall)}</td><td>{costText(g.cost)}</td>
        <td>{time(g.medianMs)} / {time(g.p95Ms)}</td><td>{g.missingUsage} / {g.failed}</td>
      </tr>)}</tbody>
    </table></div>
  </>;
}
export function Compare({ runs, selected, toggle, details }: { runs: RunListItem[]; selected: string[]; toggle: (id: string) => void; details: RunDetail[] }) {
  return <><div className="section-heading"><h2>비교할 묶음</h2><span className="muted">최대 4개 · 같은 시나리오로 비교하세요.</span></div><div className="compare-pickers">{runs.map(r => <label key={r.id}><input type="checkbox" checked={selected.includes(r.id)} onChange={() => toggle(r.id)}/>{r.name} <small>{providers[r.adapter]} · {r.variant.label} · #{r.repetition} · {date(r.createdAt)}</small></label>)}</div>{!details.length ? <div className="panel blank">위 목록에서 대화 묶음을 선택하세요.</div> : <><div className="panel table-wrap"><table className="comparison"><thead><tr><th>비교 항목</th>{details.map(d => <th key={d.run.id}>{d.run.name}<small>{providers[d.run.adapter]} · {d.run.variant.label}</small></th>)}</tr></thead><tbody>{[
    ['실행 경로', (d: RunDetail) => providers[d.run.adapter]], ['기록 구분', (d: RunDetail) => d.history?.readOnly ? '보관본' : '현재 저장소'], ['전달 방식', (d: RunDetail) => delivery[d.run.variant.deliveryMode]], ['기억 방식', (d: RunDetail) => memory[d.run.variant.memoryMode]],
    ['모델 · 추론', (d: RunDetail) => [...new Set(Object.values(d.run.sessions).map(s => `${s.config.model} / ${s.config.effort}`))].join(', ')],
    ['공개 발화 / 수신 호출', (d: RunDetail) => `${d.summary.speechCount} / ${d.summary.byKind.receive.calls}`],
    ['환경 방식', (d: RunDetail) => environmentModes[environmentMode(d.run.spec, d.run.variant)]],
    ['세계 엔진 호출 / 토큰', (d: RunDetail) => `${d.summary.byKind.environment?.calls ?? 0} / ${number(d.summary.byKind.environment?.tokens.totalTokens)}`],
    ['세계 엔진 비용', (d: RunDetail) => costText(d.summary.byKind.environment?.cost)],
    ['상황 발생 호출 / 비용', (d: RunDetail) => `${d.summary.byKind.event_generation?.calls ?? 0} / ${costText(d.summary.byKind.event_generation?.cost)}`],
    ['세계 가상 시간 / 진행 중 행동', (d: RunDetail) => `${number(d.run.worldState?.virtualSeconds)}초 / ${d.run.worldState?.spatial?.activities.filter(a => a.status === 'pending').length ?? 0}`],
    ['가상 시간', (d: RunDetail) => d.run.worldState ? `${number(d.run.worldState.virtualSeconds)}초` : '—'],
    ['전체 토큰', (d: RunDetail) => number(d.summary.tokens.totalTokens)], ['발화당 전체 토큰', (d: RunDetail) => number(d.summary.tokensPerSpeech)],
    ['API 환산 비용 (USD)', (d: RunDetail) => costText(d.summary.cost)],
    ['수신 처리 토큰', (d: RunDetail) => number(d.summary.byKind.receive.tokens.totalTokens)], ['중앙값 / P95', (d: RunDetail) => `${time(d.summary.medianMs)} / ${time(d.summary.p95Ms)}`],
    ['실제 경과 시간', (d: RunDetail) => time(d.summary.elapsedMs)], ['시간 기록', (d: RunDetail) => d.summary.timingComplete ? '정상' : '비정상 종료로 부분 집계'], ['첫 지적 발화', (d: RunDetail) => d.summary.firstIssue ? `#${d.summary.firstIssue}` : '—'],
    ['전체 지적 발화 비율', (d: RunDetail) => d.summary.issueRate === null ? '미평가' : `${number(d.summary.issueRate * 100)}%`], ['평가 완료 / 실패 구간', (d: RunDetail) => `${d.summary.evaluatedUtterances}발화 / ${d.summary.evaluationFailures}구간`],
    ['어휘 반복률', (d: RunDetail) => percent(d.summary.quality?.repetition.rate)], ['AI 의미 반복 지적률', (d: RunDetail) => percent(d.summary.quality?.semanticRepetition.rate)], ['목표 달성', (d: RunDetail) => d.summary.quality?.progression ? `${d.summary.quality.progression.achievedGoals}/${d.summary.quality.progression.totalGoals}` : '목표 미정의'], ['종료 사유', (d: RunDetail) => d.run.completionReason === 'goals_achieved' ? '목표 달성' : d.run.completionReason === 'utterance_limit' ? '발화 한도' : '—'], ['미계측 / 실패 호출', (d: RunDetail) => `${d.summary.missingUsage} / ${d.summary.failed}`],
  ].map(([label, render]) => <tr key={String(label)}><th>{String(label)}</th>{details.map(d => <td key={d.run.id}>{(render as (d: RunDetail) => string)(d)}</td>)}</tr>)}</tbody></table></div><GroupedTable details={details}/><div className="section-heading"><h2>같은 발화 순번에서 비교</h2><span className="muted">대화 경로는 모델 응답에 따라 달라집니다.</span></div><div className="compare-dialogue" style={{ gridTemplateColumns: `repeat(${details.length}, minmax(220px, 1fr))` }}>{details.map(d => <section className="panel" key={d.run.id}><h3>{d.run.name}<small>{providers[d.run.adapter]} · {d.run.variant.label}</small></h3>{d.utterances.filter(u => u.kind === 'speech').map(u => <article key={u.id}><small>#{u.speechIndex} · {u.speakerName}</small><p>{u.speech}</p><em>{u.action}</em></article>)}</section>)}</div></>}</>;
}
