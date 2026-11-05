import { useState } from 'react';
import { experimentSchema, type ExperimentSpec } from '../../../shared/schema.js';
import { errorMessage } from '../../api/client.js';
import { harborEnvironment } from '../../../shared/example-environment.js';

export interface EnvironmentDraft { text: string; baseline: string }

export function EnvironmentEditor({ spec, update, busy, stored, setStored }: {
  spec: ExperimentSpec; update: (fn: (s: ExperimentSpec) => void) => void; busy: boolean;
  stored: EnvironmentDraft | null; setStored: (draft: EnvironmentDraft | null) => void;
}) {
  const source = JSON.stringify(spec.scenario.environment ?? null, null, 2);
  const draft = stored && (stored.text !== stored.baseline || stored.baseline === source) ? stored : { text: source, baseline: source };
  const dirty = draft.text !== draft.baseline;
  const stale = dirty && draft.baseline !== source;
  const [error, setError] = useState(''); const env = spec.scenario.environment;
  return <div className="form-stack"><h3>행동과 환경 결과</h3><p>시나리오 작성자가 허용 행동·선행 조건·결과·목표를 정합니다. NPC는 행동을 선택하고 엔진이 결과를 확정합니다. 자유 서술만으로 목표가 달성되지는 않습니다.</p>
    {env && <><label className="check"><input type="checkbox" checked={env.enabled} onChange={e => update(s => { s.scenario.environment!.enabled = e.target.checked; })}/> 환경 진행 규칙 사용</label>
    <label className="check"><input type="checkbox" checked={env.stopOnGoals} onChange={e => update(s => { s.scenario.environment!.stopOnGoals = e.target.checked; })}/> 모든 목표 달성 시 종료</label><small>끄면 목표 달성 후에도 발화 한도까지 계속합니다. 규칙의 공개 사건은 매 발화 모드에서 NPC 수만큼 수신 호출을 추가합니다.</small></>}
    {!env && spec.scenario.id === 'fog-harbor' && <button onClick={() => update(s => { s.scenario.environment = harborEnvironment(); })}>안개항 환경 규칙 추가</button>}
    <details><summary>환경 규칙·목표 JSON 편집{dirty && ' · 미적용 초안'}</summary>
      {stale && <p role="alert" className="json-stale">다른 편집에서 환경 설정이 바뀌었습니다. 초안은 보존되어 있습니다. 필요한 내용을 복사한 뒤 현재 환경 설정을 다시 불러오세요.</p>}
      <label>환경 규칙 JSON<textarea aria-label="환경 규칙 JSON" rows={16} value={draft.text} onChange={e => { setStored({ text: e.target.value, baseline: draft.baseline }); setError(''); }}/></label>
      <div className="json-actions"><button disabled={busy || stale} onClick={() => { try { const value = JSON.parse(draft.text); const parsed = experimentSchema.parse({ ...spec, scenario: { ...spec.scenario, environment: value ?? undefined } }); update(s => { s.scenario.environment = parsed.scenario.environment; }); setStored(null); setError(''); } catch (error) { setError(errorMessage(error)); } }}>환경 규칙 적용</button><button disabled={busy} onClick={() => { setStored(null); setError(''); }}>현재 환경 설정 다시 불러오기</button></div>
      {dirty && <p>미적용 환경 JSON 초안이 있습니다. 적용하거나 되돌린 후 저장·실험 생성을 사용할 수 있습니다.</p>}{error && <p role="alert" className="red">{error}</p>}
    </details>
  </div>;
}
