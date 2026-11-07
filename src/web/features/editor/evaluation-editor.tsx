import { simulationEffort } from '../../../shared/role-models.js';
import { useId } from 'react';
import type { ExperimentSpec } from '../../../shared/schema.js';
import type { ModelInfo } from '../../../shared/types.js';
import { ModelSelect, modelDefaultEffort } from './model-select.js';
import { OptionToggle } from './option-toggle.js';

export function EvaluationEditor({ spec, update, models }: {
  spec: ExperimentSpec; update: (fn: (s: ExperimentSpec) => void) => void; models: ModelInfo[];
}) {
  const config = spec.evaluation, detailsId = useId();
  const efforts = (models.find(m => m.id === config.model)?.efforts ?? ['low', 'medium', 'high']).filter(simulationEffort);
  return <section className="evaluation-editor form-stack">
    <h3>독립 평가</h3>
    <OptionToggle label="주기 평가와 종료 평가 사용" title="주기 평가와 종료 평가 사용"
      description="별도 AI가 대화를 검토합니다." checked={config.enabled} controls={detailsId}
      onChange={checked => update(s => { s.evaluation.enabled = checked; })}/>
    <div id={detailsId} hidden={!config.enabled}>
      <div className="form-stack optional-settings">
        <p className="form-hint">설정한 발화 간격과 종료 시 캐릭터성·기억·세계관 이탈·대화 반복·목표 진행을 검사합니다. 평가에는 별도 토큰과 비용이 발생하며, 평가 결과는 NPC에게 전달하지 않습니다.</p>
        <div className="form-grid">
          <label>평가 모델<ModelSelect label="평가 모델" value={config.model} models={models}
            onChange={model => update(s => { s.evaluation.model = model; s.evaluation.effort = modelDefaultEffort(models, model); })}/></label>
          <label>평가 추론 강도<select aria-label="평가 추론 강도" value={config.effort}
            onChange={e => update(s => { s.evaluation.effort = e.target.value; })}>{efforts.map(e => <option key={e}>{e}</option>)}</select></label>
          <label>평가 간격 (발화)<input aria-label="평가 간격 (발화)" type="number" min={1} value={config.interval}
            onChange={e => update(s => { s.evaluation.interval = +e.target.value; })}/></label>
          <label>평가 맥락 문자 한도<input aria-label="평가 맥락 문자 한도" type="number" min={1000} max={500_000} value={config.contextCharacters}
            onChange={e => update(s => { s.evaluation.contextCharacters = +e.target.value; })}/></label>
        </div>
      </div>
    </div>
  </section>;
}
