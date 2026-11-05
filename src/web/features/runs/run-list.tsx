import type { RunListItem } from '../../../shared/types.js';
import { providers, memory, number, date, costText, environmentModes } from '../../shared/formatters.js';
import { Badge } from '../../shared/ui.js';

export function RunList({ runs, selected, select, checkedIds, onCheck }: {
  runs: RunListItem[]; selected: string; select: (id: string) => void;
  checkedIds: string[]; onCheck: (id: string, checked: boolean) => void;
}) {
  return <div className="run-cards">{runs.map(run => (
    <div className={`run-card-shell ${checkedIds.includes(run.id) ? 'checked' : ''}`} key={run.id} data-run-id={run.id}>
    <label className="run-select"><input type="checkbox" aria-label={`${run.name} 선택`} checked={checkedIds.includes(run.id)} onChange={event => onCheck(run.id, event.target.checked)}/>선택</label>
    <button className={`run-card ${selected === run.id ? 'selected' : ''}`} onClick={() => select(run.id)}>
      <div className="run-top">
        <span className="run-code">{run.variant.id.toUpperCase()} / {String(run.repetition).padStart(2, '0')}</span>
        <Badge status={run.status}/>
      </div>
      <div className="run-origin"><span>{providers[run.adapter]}</span><span>{run.history?.readOnly ? '보관본' : '현재 저장소'}</span>{run.environmentMode && <span>{environmentModes[run.environmentMode]}</span>}</div>
      <h3>{run.name}</h3>
      <p className="run-scenario">{run.scenario?.name} · {run.scenario?.characterCount}명</p>
      <p>{run.variant.label}</p>
      <small className="run-date">{date(run.createdAt)}</small>
      <p>{memory[run.variant.memoryMode]} <span>·</span> {run.variant.turnPolicy === 'director' ? 'AI 진행자' : '순번제'}</p>
      <div className="progress"><i style={{ width: `${Math.min(100, run.summary.speechCount / run.maxUtterances * 100)}%` }}/></div>
      <div className="run-bottom">
        <span><b>{run.summary.speechCount}</b> 발화</span>
        <span>{number(run.summary.tokens.totalTokens)} tokens</span>
      </div>
      <div className="run-bottom run-cost">
        <span>API 환산 비용</span>
        <b>{costText(run.summary.cost)}</b>
      </div>
    </button>
    </div>
  ))}</div>;
}
