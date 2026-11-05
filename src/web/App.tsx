import { useEffect, useMemo, useState } from 'react';
import { api } from './api/client.js';
import { useRunData } from './hooks/use-run-data.js';
import { useWorkspaceMetadata } from './hooks/use-workspace-metadata.js';
import { useActions } from './hooks/use-actions.js';
import { emptyRunFilters, filterRuns } from '../shared/run-filters.js';
import { Icon } from './shared/ui.js';
import { Editor } from './features/editor/editor.js';
import { RunList } from './features/runs/run-list.js';
import { RunWorkspace } from './features/runs/run-workspace.js';
import { RunStatistics } from './features/runs/run-statistics.js';
import { Compare } from './features/analysis/compare.js';
import { ExportView } from './features/analysis/export-view.js';
import { RunFilters } from './features/runs/run-filters.js';
import { DeleteRunDialog } from './features/runs/delete-run-dialog.js';
import { RunSelectionBar } from './features/runs/run-selection-bar.js';
import { BulkDeleteRunsDialog } from './features/runs/bulk-delete-runs-dialog.js';

export function App() {
  const [view, setView] = useState('lab');
  const [selected, setSelected] = useState('');
  const [tab, setTab] = useState('dialogue');
  const [eventText, setEventText] = useState('');
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [provider, setProvider] = useState('all');
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState(() => structuredClone(emptyRunFilters));
  const [deletingId, setDeletingId] = useState('');
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [bulkDeleting, setBulkDeleting] = useState<{ id: string; name: string }[] | null>(null);
  const [editor, setEditor] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const { allRuns, detail, compared, refresh, forgetRun } = useRunData(selected, compareIds, setError);
  const { health, history, models, spec, setSpec, refreshHistory } = useWorkspaceMetadata(setError);
  const { action, busy } = useActions(refresh, setError, setNotice);
  const runs = useMemo(() => filterRuns(allRuns, filters, provider, search), [allRuns, filters, provider, search]);
  const checkedRuns = useMemo(() => runs.filter(run => checkedIds.includes(run.id)), [runs, checkedIds]);

  useEffect(() => { if (health) setProvider(health.adapter === 'mock' ? 'all' : 'real'); }, [health?.adapter]);
  useEffect(() => {
    if (!runs.some(run => run.id === selected)) setSelected(runs[0]?.id ?? '');
  }, [allRuns, runs, selected]);
  useEffect(() => {
    const visible = new Set(runs.map(run => run.id));
    setCheckedIds(ids => { const next = ids.filter(id => visible.has(id)); return next.length === ids.length ? ids : next; });
  }, [runs]);
  const toggleCompare = (id: string) => setCompareIds(ids => ids.includes(id) ? ids.filter(value => value !== id) : [...ids.slice(-3), id]);
  const active = allRuns.filter(run => !run.history?.readOnly && run.status === 'running').length;
  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#" onClick={() => setView('lab')}><span className="brand-mark"><Icon name="lab" size={23}/></span><span>NPC<span className="brand-sub">DIALOGUE LAB</span></span></a>
      <div className="workspace-label">WORKSPACE <span>LOCAL</span></div>
      <nav>{[['lab', 'grid', '대화 실험실'], ['compare', 'compare', '비교 분석'], ['scenario', 'book', '시나리오 설정'], ['data', 'download', '데이터 내보내기']].map(([key, icon, label]) => <button key={key} className={view === key ? 'nav-item active' : 'nav-item'} onClick={() => { setView(key); if (key === 'scenario') setEditor(true); }}><Icon name={icon}/>{label}{key === 'lab' && <span className="nav-count">{runs.length}</span>}</button>)}</nav>
      <div className="sidebar-note"><span className="eyebrow">OBSERVE, DON'T CORRECT</span><p>대화가 이어질 때,<br/>캐릭터는 그대로일까요?</p><small>평가 결과는 NPC에게 전달되지 않습니다.</small></div>
      <div className="connection"><span className="status-dot"/><div>{health?.adapter === 'mock' ? '모의 엔진 연결됨' : health?.adapter === 'openai' ? 'OpenAI API 연결' : 'Codex CLI 연결'}<small>{health ? `로컬 서버 · v${health.version}` : '연결 확인 중'}</small></div></div>
    </aside>
    <main>
      <header className="topbar"><div className="breadcrumb">워크스페이스 <span>/</span> {view === 'compare' ? '비교 분석' : view === 'data' ? '데이터 내보내기' : '대화 실험실'}</div><div className="top-meta"><span className="status-dot"/>{active}개 실행 중<span className="keyboard">LOCAL ONLY</span></div></header>
      <div className="content">
        {error && <div className="alert error"><strong>확인이 필요합니다</strong><span>{error}</span><button aria-label="알림 닫기" onClick={() => setError('')}>×</button></div>}
        {notice && <div className="alert success">{notice}<button aria-label="안내 닫기" onClick={() => setNotice('')}>×</button></div>}
        <div className="page-heading"><div><div className="eyebrow">CHARACTER CONSISTENCY / EXPERIMENTS</div><h1>{view === 'compare' ? '조건을 바꾸고, 차이를 발견하세요.' : view === 'data' ? '대화를 분석 가능한 데이터로.' : '대화 속 캐릭터를 관찰하세요.'}</h1><p>캐릭터의 기억과 말투부터 세계관의 경계까지, 같은 조건에서 비교합니다.</p></div><button className="primary" onClick={() => setEditor(true)} disabled={!spec}><Icon name="plus" size={17}/> 새 실험</button></div>
        {health?.adapter === 'mock' && <div className="demo-banner">모의 엔진 · 화면과 실행 흐름을 확인하는 데이터입니다. 실제 AI 평가·사용량이 아닙니다.</div>}
        {health?.adapter === 'openai' && <div className="api-banner">OpenAI API 연결 · 서버 OPENAI_API_KEY를 사용합니다.</div>}
        <section className="history-toolbar" aria-label="기록 필터">
          <label>실행 경로<select aria-label="실행 경로" value={provider} onChange={e => setProvider(e.target.value)}><option value="real">실제 모델 전체</option><option value="codex">Codex CLI</option><option value="openai">OpenAI API</option><option value="mock">모의 엔진</option><option value="all">전체 · 모의 포함</option></select></label>
          <label className="history-search">기록 검색<input aria-label="기록 검색" placeholder="실험 이름 · 모델 · 저장 위치" value={search} onChange={e => setSearch(e.target.value)}/></label>
          <span>{runs.length} / {allRuns.length}개 표시</span><button disabled={busy || !health?.historyEnabled} onClick={() => void action(refreshHistory, { notice: '저장 위치를 다시 검색했습니다.' })}>기록 다시 검색</button>
        </section>
        <RunFilters runs={allRuns} value={filters} onChange={setFilters}/>
        {history?.enabled && <details className="history-sources"><summary>통합 보관소 · {history.archive}{history.errors.length > 0 && ` · 읽기 오류 ${history.errors.length}곳`}</summary><p>같은 실행 ID는 한 건으로 표시합니다. 다른 저장소의 기록은 보관본으로 조회하며, 원본 파일이 없어져도 통합 보관소에 남습니다. 새 저장 파일은 ‘기록 다시 검색’으로 불러옵니다.</p>{history.sources.map(s => <div key={s.path} className={s.status === 'error' ? 'red' : ''}><code>{s.path}</code><span>{s.status === 'error' ? s.error : `${s.runs}개 기록`}</span></div>)}</details>}
        <RunStatistics runs={runs}/>
        {view === 'compare' ? <Compare runs={runs} selected={compareIds} toggle={toggleCompare} details={compared}/> : view === 'data' ? <ExportView runs={runs}/> : <>
          <div className="section-heading"><h2>대화 묶음 <span>{runs.length}</span></h2><span className="muted">조건별 독립 세션 · 실시간 기록</span></div>
          <RunSelectionBar count={runs.length} selectedCount={checkedRuns.length} disabled={busy} onSelectAll={checked => setCheckedIds(checked ? runs.map(run => run.id) : [])} onClear={() => setCheckedIds([])} onDelete={() => setBulkDeleting(checkedRuns.map(run => ({ id: run.id, name: run.name })))}/>
          {!runs.length ? <div className="empty-lab"><div className="empty-orbits"><span>윤</span><span>도하</span><span>미루</span><i/></div><h2>{allRuns.length ? '검색 조건에 맞는 기록이 없습니다.' : '첫 번째 대화를 시작해 보세요.'}</h2><p>{allRuns.length ? '실행 경로와 검색어를 변경하거나 저장 위치를 다시 검색하세요.' : '준비된 안개항 시나리오를 사용하거나 직접 캐릭터와 세계관을 입력할 수 있습니다.'}</p><button className="primary" onClick={() => setEditor(true)} disabled={!spec}>실험 구성하기 <Icon name="arrow" size={16}/></button><div className="empty-features"><span>01 독립 NPC 세션</span><span>02 두 가지 전달 방식</span><span>03 토큰·시간 계측</span></div></div> : <>
            <RunList runs={runs} selected={selected} select={id => { setSelected(id); setTab('dialogue'); }} checkedIds={checkedIds} onCheck={(id, checked) => setCheckedIds(ids => checked ? [...new Set([...ids, id])] : ids.filter(value => value !== id))}/>
            {detail && detail.run.id === selected && <RunWorkspace detail={detail} busy={busy} tab={tab} setTab={setTab} eventText={eventText} setEventText={setEventText} onControl={control => void action(() => api.controlRun(selected, control), { runId: selected })} onInject={(text, audience) => action(() => api.inject(selected, text, audience), { runId: selected })} onReview={(id, patch) => void action(() => api.reviewFinding(id, patch), { runId: selected })} onCompare={() => { toggleCompare(selected); setView('compare'); }} onDelete={() => setDeletingId(selected)}/>}
          </>}
        </>}
        <footer className="page-footer"><span>NPC DIALOGUE LAB</span><span>대화·수신·평가·계측 기록과 통합 보관소는 로컬에 저장됩니다.</span></footer>
      </div>
    </main>
    {deletingId && <DeleteRunDialog key={deletingId} id={deletingId} close={() => setDeletingId('')} onDeleted={id => {
      forgetRun(id); setCompareIds(ids => ids.filter(value => value !== id));
      if (selected === id) setSelected('');
      setNotice('대화 묶음과 연결된 원본·보관 기록을 삭제했습니다.');
      void action(health?.historyEnabled ? refreshHistory : () => Promise.resolve());
    }}/>}
    {bulkDeleting && <BulkDeleteRunsDialog runs={bulkDeleting} close={() => setBulkDeleting(null)} onResult={result => {
      const deleted = new Set(result.results.filter(entry => entry.status === 'deleted').map(entry => entry.runId));
      for (const id of deleted) forgetRun(id);
      setCheckedIds(ids => ids.filter(id => !deleted.has(id)));
      setCompareIds(ids => ids.filter(id => !deleted.has(id)));
      if (deleted.has(selected)) setSelected('');
      const blocked = result.results.filter(entry => entry.status === 'blocked').length;
      const failed = result.results.filter(entry => entry.status === 'failed').length;
      setNotice(`선택한 묶음 ${result.results.length}개 중 ${deleted.size}개를 삭제했습니다.${blocked ? ` 삭제 제외 ${blocked}개.` : ''}${failed ? ` 삭제 실패 ${failed}개.` : ''}`);
      void action(health?.historyEnabled ? refreshHistory : () => Promise.resolve());
    }}/>}
    <div hidden={!editor}>{spec && <Editor message={error || notice} spec={spec} setSpec={setSpec} models={models} close={() => setEditor(false)} busy={busy} save={() => void action(() => api.saveConfig(spec), { notice: '설정을 저장했습니다.' })} launch={(start: boolean) => void action(async () => { const result = await api.createExperiment(spec, start); setSelected(result.runs[0].id); setCompareIds(result.runs.slice(0, 4).map(r => r.id)); setEditor(false); setView('lab'); })} validate={() => void action(() => api.validate(spec), { notice: '설정과 모델·추론 조합이 유효합니다.' })}/>}</div>
  </div>;
}
