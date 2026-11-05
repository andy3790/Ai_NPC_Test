import { useState, type Dispatch, type SetStateAction } from 'react';
import type { ExperimentSpec } from '../../../shared/schema.js';
import { applyConfigSection, configSectionError, configSectionLabels, readConfigSection, type ConfigSection } from '../../../shared/config-sections.js';

export interface ConfigDraft { text: string; baseline: string; error?: string }
const descriptions: Record<ConfigSection, string> = {
  full: '실험 전체 객체입니다. 기존 전체 JSON 편집과 파일 가져오기를 그대로 사용할 수 있습니다.',
  world: 'scenario에서 characters를 제외한 객체입니다. ID·이름·세계 설정·시작 상황·기본 모델·환경 규칙을 편집합니다.',
  character: '선택한 NPC 한 명의 객체입니다. 다른 NPC의 설정과 순서는 유지합니다.',
  characters: '모든 NPC 객체의 배열입니다. 배열 순서가 순번제의 발화 순서입니다.',
  conditions: '비교 조건·반복·발화 한도·동시 실행·평가·진행자·예약 사건을 편집합니다. 세계관과 캐릭터는 유지합니다.',
};
export function ConfigJsonEditor({ spec, section, setSection, characterIndex, setCharacterIndex, apply, busy, drafts, setDrafts }: {
  spec: ExperimentSpec; section: ConfigSection; setSection: (value: ConfigSection) => void;
  characterIndex: number; setCharacterIndex: (value: number) => void;
  apply: (value: ExperimentSpec) => void; busy: boolean;
  drafts: Record<string, ConfigDraft>; setDrafts: Dispatch<SetStateAction<Record<string, ConfigDraft>>>;
}) {
  const [notice, setNotice] = useState('');
  const index = Math.min(characterIndex, spec.scenario.characters.length - 1);
  const key = section === 'character' ? `character:${spec.scenario.characters[index].id}` : section;
  const source = JSON.stringify(readConfigSection(spec, section, index), null, 2);
  const stored = drafts[key];
  const draft = stored && (stored.text !== stored.baseline || stored.baseline === source) ? stored : { text: source, baseline: source };
  const dirty = draft.text !== draft.baseline, stale = dirty && draft.baseline !== source;
  const count = Object.values(drafts).filter(d => d.text !== d.baseline).length;
  const edit = (text: string) => { setDrafts(all => ({ ...all, [key]: { text, baseline: draft.baseline } })); setNotice(''); };
  const reset = () => { setDrafts(all => { const next = { ...all }; delete next[key]; return next; }); setNotice('현재 설정을 불러왔습니다.'); };
  const commit = () => {
    try {
      const next = applyConfigSection(spec, section, JSON.parse(draft.text.replace(/^\uFEFF/, '')), index);
      apply(next);
      setDrafts(all => { const remaining = { ...all }; delete remaining[key]; return remaining; });
      setNotice(`${configSectionLabels[section]} JSON을 설정에 적용했습니다.`);
    } catch (error) { setDrafts(all => ({ ...all, [key]: { ...draft, error: configSectionError(error) } })); }
  };
  return <div className="form-stack section-json">
    <div className="json-scope-options" role="group" aria-label="JSON 편집 범위">{Object.entries(configSectionLabels).map(([value, label]) => {
      const pending = Object.entries(drafts).filter(([key, d]) => (value === 'character' ? key.startsWith('character:') : key === value) && d.text !== d.baseline).length;
      return <button key={value} aria-pressed={section === value} className={section === value ? 'active' : ''} onClick={() => { setSection(value as ConfigSection); setNotice(''); }}>{label}{pending > 0 && <small> · 미적용 {pending}</small>}</button>;
    })}</div>
    <p className="form-hint">{descriptions[section]} 해당 범위 전체를 교체하며, 다른 범위는 보존합니다. 편집 후 적용 버튼을 누르세요.</p>
    {section === 'character' && <label>편집할 캐릭터<select aria-label="JSON 편집 캐릭터" value={index} onChange={e => { setCharacterIndex(+e.target.value); setNotice(''); }}>{spec.scenario.characters.map((c, i) => <option key={c.id} value={i}>{c.name} · {c.id}</option>)}</select></label>}
    {section === 'world' && <p className="form-hint">environment를 생략하면 환경 규칙이 제거됩니다. 캐릭터 ID와 연결된 actorIds는 유지하거나 전체 JSON에서 함께 수정하세요.</p>}
    {section === 'characters' && <p className="form-hint">최소 2명입니다. ID를 바꾸거나 NPC를 제거할 때 환경 행동의 actorIds 연결도 유효해야 합니다.</p>}
    {stale && <div className="json-stale" role="alert">다른 편집에서 이 범위의 설정이 바뀌었습니다. 초안은 보존되어 있습니다. 필요한 내용을 복사한 뒤 ‘현재 설정 다시 불러오기’로 최신 설정을 불러와 수정하세요.</div>}
    <label>{configSectionLabels[section]} JSON<textarea aria-label={`${configSectionLabels[section]} JSON`} className="json-editor" spellCheck={false} rows={24} value={draft.text} onChange={e => edit(e.target.value)}/></label>
    {draft.error && <pre className="json-error" role="alert">적용하지 않았습니다. 기존 설정이 유지됩니다.{ '\n' }{draft.error}</pre>}
    {notice && <p className="json-notice" role="status">{notice}</p>}
    <div className="json-actions"><button disabled={busy || stale} onClick={commit}>{section === 'full' ? 'JSON을 설정에 적용' : `${configSectionLabels[section]} JSON 적용`}</button><button disabled={busy} onClick={reset}>현재 설정 다시 불러오기</button></div>
    <label>파일 가져오기<input key={key} type="file" accept=".json,application/json" disabled={busy} onChange={async e => {
      const file = e.target.files?.[0]; if (!file) return;
      try { edit(await file.text()); } catch (error) { setDrafts(all => ({ ...all, [key]: { ...draft, error: configSectionError(error) } })); }
    }}/><small>선택한 범위와 같은 형식의 JSON을 가져옵니다. 전체 캐릭터는 배열, 나머지는 객체입니다.</small></label>
    {count > 0 && <div className="json-pending"><span>미적용 JSON 초안 {count}개 · 적용하거나 되돌린 후 저장·실험 생성을 사용할 수 있습니다.</span><button onClick={() => { setDrafts({}); setNotice('모든 JSON 초안을 되돌렸습니다.'); }} disabled={busy}>모든 JSON 초안 되돌리기</button></div>}
  </div>;
}
