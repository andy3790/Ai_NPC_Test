import { isAiEnvironment, type ExperimentSpec } from '../../../shared/schema.js';
import type { ModelInfo } from '../../../shared/types.js';

export function SituationEditor({ spec, update, models }: { spec: ExperimentSpec; update: (fn: (s: ExperimentSpec) => void) => void; models: ModelInfo[] }) {
  const config = spec.eventGenerator;
  const enabled = spec.variants.some(v => v.eventGeneration);
  const efforts = (model: string) => (models.find(m => m.id === model)?.efforts ?? ['low', 'medium', 'high']).filter(e => e !== 'ultra');
  return <section className="form-stack"><h3>상황 발생 엔진 · 선택 사항</h3><p className="form-hint">별도 AI가 세계관에 맞는 사건을 제안하고 세계 엔진이 검토합니다. NPC의 선택·감정은 대신 정하지 않습니다. 침묵한 제안 호출도 사용량에 포함됩니다.</p>
    {spec.variants.map((v, i) => <label className="checkbox" key={v.id}><input aria-label={`${v.label} 상황 발생`} type="checkbox" disabled={!isAiEnvironment(spec, v)} checked={!!v.eventGeneration} onChange={e => update(s => {
      s.variants[i].eventGeneration = e.target.checked;
      if (e.target.checked) s.eventGenerator ??= { ...s.scenario.defaults, intervalSeconds: 30, minGapSeconds: 60, maxProposals: 10, maxChecks: 30, maxSeverity: 'medium', allowedEvents: '', forbiddenEvents: '' };
    })}/>{v.label} · 상황 발생 사용</label>)}
    {enabled && config && <><div className="form-grid">
      <label>상황 발생 모델<select aria-label="상황 발생 모델" value={config.model} onChange={e => update(s => { s.eventGenerator!.model = e.target.value; s.eventGenerator!.effort = efforts(e.target.value)[0]; })}>{models.map(m => <option key={m.id}>{m.id}</option>)}</select></label>
      <label>상황 발생 추론 강도<select value={config.effort} onChange={e => update(s => { s.eventGenerator!.effort = e.target.value; })}>{efforts(config.model).map(e => <option key={e}>{e}</option>)}</select></label>
      {([['intervalSeconds', '검토 간격 (가상 초)'], ['minGapSeconds', '채택 사건 간 최소 간격 (가상 초)'], ['maxChecks', '최대 검토 호출 수'], ['maxProposals', '최대 제안 수']] as const).map(([key, label]) => <label key={key}>{label}<input aria-label={label} type="number" min={key === 'minGapSeconds' ? 0 : 1} value={config[key]} onChange={e => update(s => { s.eventGenerator![key] = +e.target.value; })}/></label>)}
      <label>최대 강도<select aria-label="상황 최대 강도" value={config.maxSeverity} onChange={e => update(s => { s.eventGenerator!.maxSeverity = e.target.value as typeof config.maxSeverity; })}><option value="low">낮음 · 일상적 불편</option><option value="medium">중간 · 사고·갈등</option><option value="high">높음 · 위협·중대한 사고</option></select></label>
    </div><label>발생 가능한 사건 범위<textarea aria-label="발생 가능한 사건 범위" value={config.allowedEvents} onChange={e => update(s => { s.eventGenerator!.allowedEvents = e.target.value; })} placeholder="이 세계에서 발생시켜도 되는 사고·위협·갈등을 구체적으로 작성하세요."/></label>
    <label>금지할 사건<textarea aria-label="금지할 사건" value={config.forbiddenEvents} onChange={e => update(s => { s.eventGenerator!.forbiddenEvents = e.target.value; })}/></label></>}
  </section>;
}
