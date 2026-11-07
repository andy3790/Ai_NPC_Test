import { simulationEffort } from '../../../shared/role-models.js';
import { useId } from 'react';
import { isAiEnvironment, type ExperimentSpec, type ModelConfig } from '../../../shared/schema.js';
import type { ModelInfo } from '../../../shared/types.js';
import { ModelSelect, modelDefaultEffort } from './model-select.js';
import { OptionToggle } from './option-toggle.js';

export function SituationEditor({ spec, update, models, defaultConfig }: { spec: ExperimentSpec; update: (fn: (s: ExperimentSpec) => void) => void; models: ModelInfo[]; defaultConfig: ModelConfig }) {
  const config = spec.eventGenerator;
  const enabled = spec.variants.some(v => v.eventGeneration);
  const detailsId = useId(), scopeHintId = useId();
  const efforts = (model: string) => (models.find(m => m.id === model)?.efforts ?? ['low', 'medium', 'high']).filter(simulationEffort);
  return <section className="situation-editor form-stack"><h3>상황 발생 엔진 · 선택 사항</h3><p className="form-hint">별도 AI가 세계관에 맞는 사건을 제안하고 세계 엔진이 검토합니다. NPC의 선택·감정은 대신 정하지 않습니다. 침묵한 제안 호출도 사용량에 포함됩니다.</p>
    <div className="option-toggle-list">{spec.variants.map((v, i) => <OptionToggle key={v.id}
      label={`${v.label} 상황 발생`} title={v.label} controls={detailsId}
      description={isAiEnvironment(spec, v) ? '상황 발생 사용' : '세계 엔진을 AI 단일 공간 또는 분산 공간으로 설정하면 사용할 수 있습니다.'}
      disabled={!isAiEnvironment(spec, v)} checked={!!v.eventGeneration} onChange={checked => update(s => {
        s.variants[i].eventGeneration = checked;
        if (checked) s.eventGenerator ??= { ...defaultConfig, intervalSeconds: 30, minGapSeconds: 60, maxProposals: 10, maxChecks: 30, maxSeverity: 'medium', allowedEvents: '', forbiddenEvents: '' };
      })}/>)}</div>
    <div id={detailsId} hidden={!enabled}>{config && <div className="form-stack optional-settings"><div className="form-grid">
      <label>상황 발생 모델<ModelSelect label="상황 발생 모델" value={config.model} models={models} onChange={value => update(s => { s.eventGenerator!.model = value; s.eventGenerator!.effort = modelDefaultEffort(models, value); })}/></label>
      <label>상황 발생 추론 강도<select value={config.effort} onChange={e => update(s => { s.eventGenerator!.effort = e.target.value; })}>{efforts(config.model).map(e => <option key={e}>{e}</option>)}</select></label>
      {([['intervalSeconds', '검토 간격 (가상 초)'], ['minGapSeconds', '채택 사건 간 최소 간격 (가상 초)'], ['maxChecks', '최대 검토 호출 수'], ['maxProposals', '최대 제안 수']] as const).map(([key, label]) => <label key={key}>{label}<input aria-label={label} type="number" min={key === 'minGapSeconds' ? 0 : 1} value={config[key]} onChange={e => update(s => { s.eventGenerator![key] = +e.target.value; })}/></label>)}
      <label>최대 강도<select aria-label="상황 최대 강도" value={config.maxSeverity} onChange={e => update(s => { s.eventGenerator!.maxSeverity = e.target.value as typeof config.maxSeverity; })}><option value="low">낮음 · 일상적 불편</option><option value="medium">중간 · 사고·갈등</option><option value="high">높음 · 위협·중대한 사고</option></select></label>
    </div><label>발생 가능한 사건 범위 · 필수<textarea aria-label="발생 가능한 사건 범위" aria-required={enabled} aria-invalid={enabled && !config.allowedEvents.trim()} aria-describedby={scopeHintId} value={config.allowedEvents} onChange={e => update(s => { s.eventGenerator!.allowedEvents = e.target.value; })} placeholder="이 세계에서 발생시켜도 되는 사고·위협·갈등을 구체적으로 작성하세요."/>
      <small id={scopeHintId} className={enabled && !config.allowedEvents.trim() ? 'field-error' : undefined}>{enabled && !config.allowedEvents.trim() ? '상황 발생 엔진을 사용하려면 발생 가능한 사건 범위를 입력하세요.' : '선택한 조건에 공통으로 적용됩니다.'}</small></label>
    <label>금지할 사건<textarea aria-label="금지할 사건" value={config.forbiddenEvents} onChange={e => update(s => { s.eventGenerator!.forbiddenEvents = e.target.value; })}/></label></div>}</div>
  </section>;
}
