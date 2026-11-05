import type { RunDetail } from '../../../shared/types.js';
import { delivery, memory, providers, callKinds, number, time, usd, costText } from '../../shared/formatters.js';
import { PRICING_DATE, PRICING_SOURCE } from '../../../core/pricing.js';
import { Icon } from '../../shared/ui.js';
import { Quality } from './quality.js';
import { Sparkline } from './sparkline.js';

export function RunInspector({ detail, onCompare }: { detail: RunDetail; onCompare: () => void }) {
  return <aside className="inspector"><section className="panel"><div className="mini-title"><h3>실험 조건</h3><span>SNAPSHOT</span></div><dl><dt>실행 경로</dt><dd>{providers[detail.run.adapter]}</dd><dt>대화 전달</dt><dd>{delivery[detail.run.variant.deliveryMode]}</dd><dt>기억 제공</dt><dd>{memory[detail.run.variant.memoryMode]}</dd><dt>진행 방식</dt><dd>{detail.run.variant.turnPolicy === 'director' ? 'AI 진행자' : '순번제'}</dd><dt>발화 한도</dt><dd>{detail.summary.speechCount} / {detail.run.spec.maxUtterances}</dd><dt>평가 간격</dt><dd>{detail.run.spec.evaluation.enabled ? `${detail.run.spec.evaluation.interval}발화마다` : '평가 꺼짐'}</dd></dl><button className="full-button" onClick={onCompare}>비교에 추가 <Icon name="compare" size={15}/></button></section>
              <section className="panel"><div className="mini-title"><h3>사용량 구성</h3><span>TOKENS</span></div><div className="token-total">{number(detail.summary.tokens.totalTokens)}<small>확인된 토큰 합계</small></div>{callKinds.map(([kind, label], i) => <div className="usage-row" key={kind}><div><span><i className={`legend c${i}`}/>{label}</span><b>{number(detail.summary.byKind[kind]?.tokens.totalTokens)}</b></div><div className="usage-track"><i className={`c${i}`} style={{ width: `${(detail.summary.byKind[kind].tokens.totalTokens ?? 0) / Math.max(1, detail.summary.tokens.totalTokens ?? 0) * 100}%` }}/></div></div>)}<div className="measurement-note">미계측 {detail.summary.missingUsage}건 · 실패 {detail.summary.failed}건<br/>캐시·추론 토큰은 중복 합산하지 않습니다.</div></section>
              <section className="panel">
                <div className="mini-title"><h3>API 환산 비용</h3><span>USD</span></div>
                <div className="token-total">{usd(detail.summary.cost?.usd)}<small>집계 가능한 호출의 예상 합계</small></div>
                {callKinds.map(([kind, label]) => <div className="usage-row" key={kind}><div>
                  <span>{label}</span><b>{costText(detail.summary.byKind[kind].cost)}</b>
                </div></div>)}
                <div className="measurement-note">
                  {detail.run.adapter === 'mock' ? '모의 실행은 비용 환산 대상에서 제외됩니다.' : 'Standard 요금 · 캐시 쓰기 30분 기준 · 청구 내역과 차이가 있을 수 있습니다.'}
                  {!!detail.summary.cost?.unpricedCalls && <><br/>미산정 {detail.summary.cost.unpricedCalls}건</>}
                  {!!detail.summary.cost?.assumedCalls && <><br/>가정 적용 {detail.summary.cost.assumedCalls}건</>}
                  <br/><a href={PRICING_SOURCE} target="_blank" rel="noreferrer">OpenAI 공식 요금표</a> · {PRICING_DATE} 확인
                </div>
              </section>
              <section className="panel"><div className="mini-title"><h3>응답 시간</h3><Icon name="clock" size={16}/></div><div className="latency-pair"><div><small>중앙값</small><strong>{time(detail.summary.medianMs)}</strong></div><div><small>P95</small><strong>{time(detail.summary.p95Ms)}</strong></div></div><Sparkline calls={detail.invocations}/><div className="measurement-note">성공한 호출 기준 · 네트워크 포함<br/>실제 경과 {time(detail.summary.elapsedMs)}</div></section>
            <Quality detail={detail}/></aside>;
}
