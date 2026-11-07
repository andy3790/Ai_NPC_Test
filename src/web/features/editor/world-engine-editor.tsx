import { simulationEffort } from '../../../shared/role-models.js';
import { environmentMode, isAiEnvironment, type ExperimentSpec, type ModelConfig, type Variant } from '../../../shared/schema.js';
import type { ModelInfo } from '../../../shared/types.js';
import { ModelSelect, modelDefaultEffort } from './model-select.js';
import { environmentModes } from '../../shared/formatters.js';

export function WorldEngineEditor({ spec, update, models, defaultConfig }: { spec: ExperimentSpec; update: (fn: (s: ExperimentSpec) => void) => void; models: ModelInfo[]; defaultConfig: ModelConfig }) {
  const config = spec.worldEngine ?? defaultConfig;
  const enabled = spec.variants.some(v => isAiEnvironment(spec, v));
  const efforts = (model: string) => (models.find(m => m.id === model)?.efforts ?? ['low', 'medium', 'high']).filter(simulationEffort);
  return <section className="world-engine-editor form-stack">
    <h3>세계 엔진</h3>
    <p className="form-hint">AI 세계 엔진은 각 NPC 발언 뒤에 행동 결과·가상 시간·지연 사건을 처리합니다. NPC의 자발적 행동과 내면은 결정하지 않습니다. 조건마다 다른 모드를 선택해 비교할 수 있습니다.</p>
    <div className="form-grid">{spec.variants.map((v, i) => <label key={v.id}>{v.label} · 환경 방식
      <select aria-label={`${v.label} 환경 방식`} value={environmentMode(spec, v)} onChange={e => update(s => {
        s.variants[i].environmentMode = e.target.value as Variant['environmentMode'];
        if (['ai', 'ai_spatial'].includes(e.target.value)) s.worldEngine ??= { ...defaultConfig };
        else s.variants[i].eventGeneration = false;
      })}>{Object.entries(environmentModes).map(([key, label]) => <option key={key} value={key} disabled={key === 'rules' && !spec.scenario.environment?.enabled}>{label}</option>)}</select>
    </label>)}</div>
    {enabled && <>
      <div className="form-grid">
        <label>세계 엔진 모델<ModelSelect label="세계 엔진 모델" value={config.model} models={models} onChange={value => update(s => { s.worldEngine = { model: value, effort: modelDefaultEffort(models, value) }; })}/></label>
        <label>세계 엔진 추론 강도<select aria-label="세계 엔진 추론 강도" value={config.effort} onChange={e => update(s => { s.worldEngine = { ...config, effort: e.target.value }; })}>{efforts(config.model).map(e => <option key={e}>{e}</option>)}</select></label>
      </div>
      <label>세계 엔진 추가 규칙 (선택)<textarea aria-label="세계 엔진 추가 규칙" rows={3} value={spec.scenario.worldEngineInstructions ?? ''} onChange={e => update(s => { s.scenario.worldEngineInstructions = e.target.value; })} placeholder="예: 연락은 즉답하지 않으며 장면의 가상 시간에 맞춰 도착한다."/></label>
      <p className="form-hint">단일 공간은 발화 뒤 엔진 1회, 분산 공간은 시간 계획과 결과 처리 시점에 엔진을 호출합니다. 결과가 없어도 호출 비용은 발생합니다. 분산 공간은 ‘01 시나리오’에서 장소·통로·NPC 시작 위치를 작성하세요. 엔진은 세계·대화·실제 행동과 NPC ID·이름만 읽고 캐릭터 비공개 설정은 읽지 않습니다.</p>
    </>}
  </section>;
}
