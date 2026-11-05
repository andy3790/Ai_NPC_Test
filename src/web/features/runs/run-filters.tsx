import { emptyRunFilters, filterErrors, type RunFilters as Filters } from '../../../shared/run-filters.js';
import type { RunListItem } from '../../../shared/types.js';
import { delivery, memory, states, environmentModes } from '../../shared/formatters.js';

function Choices({ label, options, value, onChange }: { label: string; options: [string, string][]; value: string[]; onChange: (value: string[]) => void }) {
  return <details className="filter-choices"><summary>{label}<span>{value.length ? `${value.length}개 선택` : '전체'}</span></summary>
    <div role="group" aria-label={label}>{options.map(([key, text]) => <label key={key}><input type="checkbox" checked={value.includes(key)} onChange={e => onChange(e.target.checked ? [...value, key] : value.filter(item => item !== key))}/>{text}</label>)}
    {!options.length && <small>저장된 기록이 없습니다.</small>}</div>
  </details>;
}

export function RunFilters({ runs, value, onChange }: { runs: RunListItem[]; value: Filters; onChange: (filters: Filters) => void }) {
  const set = <K extends keyof Filters>(key: K, next: Filters[K]) => onChange({ ...value, [key]: next });
  const unique = (items: string[]): [string, string][] => [...new Set(items)].sort().map(item => [item, item]);
  const configs = runs.flatMap(run => run.npcConfigs ?? []);
  const scenarios = [...new Map(runs.filter(run => run.scenario).map(run => [run.scenario.id, `${run.scenario.name} · ${run.scenario.id}`])).entries()];
  const count = Object.entries(value).filter(([key, item]) => key !== 'sort' && (Array.isArray(item) ? item.length : !!item)).length;
  const errors = filterErrors(value);
  return <details className="advanced-filters">
    <summary>상세 필터 <span>{count ? `${count}개 조건 적용` : '모델 · 시나리오 · 날짜 · 비용 · 발화 수'}</span></summary>
    <div className="filter-heading"><p>같은 항목의 여러 선택은 하나 이상 일치, 서로 다른 항목은 모두 일치해야 합니다. 모델·추론은 NPC별 적용 설정 기준입니다.</p><button onClick={() => onChange(structuredClone(emptyRunFilters))}>상세 필터 초기화</button></div>
    <div className="filter-grid">
      <Choices label="NPC 모델" options={unique(configs.map(c => c.model))} value={value.models} onChange={next => set('models', next)}/>
      <Choices label="추론 강도" options={unique(configs.map(c => c.effort))} value={value.efforts} onChange={next => set('efforts', next)}/>
      <Choices label="시나리오" options={scenarios} value={value.scenarios} onChange={next => set('scenarios', next)}/>
      <Choices label="실행 상태" options={['queued', 'running', 'paused', 'completed', 'stopped'].map(key => [key, states[key]])} value={value.statuses} onChange={next => set('statuses', next)}/>
      <Choices label="대화 전달 방식" options={Object.entries(delivery)} value={value.deliveryModes} onChange={next => set('deliveryModes', next)}/>
      <Choices label="기억 제공 방식" options={Object.entries(memory)} value={value.memoryModes} onChange={next => set('memoryModes', next)}/>
      <Choices label="환경 방식" options={Object.entries(environmentModes)} value={value.environmentModes} onChange={next => set('environmentModes', next)}/>
      <Choices label="진행 방식" options={[["round_robin", '순번제'], ['director', 'AI 진행자']]} value={value.turnPolicies} onChange={next => set('turnPolicies', next)}/>
      <label>기록 위치<select aria-label="기록 위치 필터" value={value.origin} onChange={e => set('origin', e.target.value)}><option value="">전체</option><option value="current">현재 저장소</option><option value="archive">보관 기록</option></select></label>
      <label>특정 날짜 (KST)<input aria-label="특정 날짜" type="date" value={value.dateFrom === value.dateTo ? value.dateFrom : ''} onChange={e => onChange({ ...value, dateFrom: e.target.value, dateTo: e.target.value })}/></label>
      <label>시작 날짜 (KST)<input aria-label="시작 날짜" type="date" value={value.dateFrom} onChange={e => set('dateFrom', e.target.value)}/></label>
      <label>종료 날짜 (KST, 당일 포함)<input aria-label="종료 날짜" type="date" value={value.dateTo} onChange={e => set('dateTo', e.target.value)}/></label>
      <label>비용 산정 상태<select aria-label="비용 산정 상태" value={value.costCoverage} onChange={e => set('costCoverage', e.target.value)}><option value="">전체</option><option value="complete">미산정 호출 없음</option><option value="partial">일부 호출만 산정</option><option value="missing">비용 미산정 · 해당 없음</option><option value="assumed">가정 적용 있음</option></select></label>
      {([['API 환산 비용 (USD)', 'costMin', 'costMax'], ['공개 발화 수', 'speechMin', 'speechMax'], ['전체 토큰 수', 'tokenMin', 'tokenMax'], ['NPC 수', 'npcMin', 'npcMax'], ['응답 시간 중앙값 (초)', 'latencyMin', 'latencyMax']] as const).map(([label, min, max]) => <fieldset key={min} className="filter-range"><legend>{label}</legend><div>
        <input type="number" min="0" step={min === 'costMin' || min === 'latencyMin' ? 'any' : '1'} aria-label={`${label} 최소`} placeholder="최소" value={value[min]} onChange={e => set(min, e.target.value)}/><span>~</span>
        <input type="number" min="0" step={min === 'costMin' || min === 'latencyMin' ? 'any' : '1'} aria-label={`${label} 최대`} placeholder="최대" value={value[max]} onChange={e => set(max, e.target.value)}/></div></fieldset>)}
      <label>정렬<select aria-label="기록 정렬" value={value.sort} onChange={e => set('sort', e.target.value)}>{[
        ['newest', '최신순'], ['oldest', '오래된 순'], ['cost_desc', '비용 높은 순'], ['cost_asc', '비용 낮은 순'],
        ['speech_desc', '발화 많은 순'], ['speech_asc', '발화 적은 순'], ['tokens_desc', '토큰 많은 순'], ['tokens_asc', '토큰 적은 순'], ['latency_asc', '응답 빠른 순'], ['latency_desc', '응답 느린 순'],
      ].map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select></label>
    </div>
    <p className="filter-note">생성 날짜 기준 · 범위의 양 끝값 포함 · 수치 범위를 지정하면 미계측 값은 제외됩니다. 비용은 산정 가능한 호출의 USD 합계이며 부분 산정 여부를 함께 확인하세요.</p>
    {errors.length > 0 && <div role="alert" className="filter-errors">{errors.map(error => <p key={error}>{error}</p>)}</div>}
  </details>;
}
