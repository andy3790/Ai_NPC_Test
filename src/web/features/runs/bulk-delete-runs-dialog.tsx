import { useEffect, useRef, useState } from 'react';
import type { BulkRunDeletionPlan, BulkRunDeletionResult } from '../../../shared/types.js';
import { api, errorMessage } from '../../api/client.js';

export function BulkDeleteRunsDialog({ runs, close, onResult }: {
  runs: { id: string; name: string }[]; close: () => void; onResult: (result: BulkRunDeletionResult) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [plan, setPlan] = useState<BulkRunDeletionPlan | null>(null);
  const [result, setResult] = useState<BulkRunDeletionResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    dialog.current?.showModal();
    void api.bulkDeletionPlan(runs.map(run => run.id)).then(value => { if (!cancelled) setPlan(value); })
      .catch(error => { if (!cancelled) setError(errorMessage(error)); });
    return () => { cancelled = true; dialog.current?.close(); };
  }, [runs, revision]);
  const remove = async () => {
    if (!plan?.deletableCount || busy || result) return;
    setBusy(true); setError('');
    try {
      const value = await api.deleteRuns(runs.map(run => run.id), plan.token);
      setResult(value); onResult(value);
      if (value.results.every(entry => entry.status === 'deleted')) close();
    } catch (error) { setError(errorMessage(error)); setPlan(null); }
    finally { setBusy(false); }
  };
  const completed = result?.results.filter(entry => entry.status === 'deleted').length ?? 0;
  const failed = result?.results.filter(entry => entry.status === 'failed').length ?? 0;
  const blocked = result?.results.filter(entry => entry.status === 'blocked').length ?? 0;
  return <dialog className="delete-dialog bulk-delete-dialog" ref={dialog} aria-labelledby="bulk-delete-title" onCancel={event => { event.preventDefault(); if (!busy) close(); }}>
    <h2 id="bulk-delete-title">{result ? '선택한 묶음 삭제 결과' : `대화 묶음 ${runs.length}개를 영구 삭제할까요?`}</h2>
    <p className="bulk-delete-count" role="status">{result
      ? `선택 ${runs.length}개 · 삭제 완료 ${completed}개 · 제외 ${blocked}개 · 실패 ${failed}개`
      : `선택 ${runs.length}개${plan ? ` · 삭제 가능 ${plan.deletableCount}개 · 제외 ${plan.selectedCount - plan.deletableCount}개` : ''}`}</p>
    {!result && <p>선택한 묶음의 대화·호출·수신·평가·계측·설정과 연결된 원본·보관 파일을 실제로 삭제합니다. 복구할 수 없습니다.</p>}
    {!plan && !error && <p role="status">선택한 묶음의 원본과 보관본을 확인하고 있습니다…</p>}
    <ul className="bulk-delete-list" aria-label="선택한 삭제 대상 목록">{runs.map(run => {
      const entry = plan?.entries.find(entry => entry.runId === run.id);
      const outcome = result?.results.find(entry => entry.runId === run.id);
      const reason = outcome?.error ?? entry?.error ?? entry?.plan?.blockers.join('\n');
      const label = outcome ? { deleted: '삭제 완료', blocked: '삭제 제외', failed: '삭제 실패' }[outcome.status]
        : entry ? entry.plan?.allowed ? '삭제 가능' : '삭제 제외' : error ? '재확인 필요' : '확인 중';
      return <li key={run.id} data-run-id={run.id}>
        <div><strong>{entry?.plan?.name ?? run.name}</strong><span className={label === '삭제 제외' || label === '삭제 실패' ? 'red' : ''}>{label}</span></div>
        <code>{run.id}</code>
        {reason && <p className="filter-errors">{reason}</p>}
        {entry?.plan && <small>공개 발화 {entry.plan.speechCount}건 · 호출 {entry.plan.invocationCount}건</small>}
        {entry?.plan && <details><summary>저장 위치 {entry.plan.targets.length}곳</summary>{entry.plan.targets.map(target => <code key={target.path}>{target.path}</code>)}</details>}
      </li>;
    })}</ul>
    {!result && !!plan && plan.deletableCount < plan.selectedCount && <p className="snapshot-note">삭제 제외 항목은 유지됩니다. 삭제 가능한 {plan.deletableCount}개만 처리합니다.</p>}
    {result && <p className="snapshot-note">삭제되지 않은 묶음은 선택된 상태로 남습니다. 원인을 해결한 뒤 다시 확인할 수 있습니다.</p>}
    {!result && <p className="snapshot-note">별도로 복사한 파일·다운로드한 ZIP·Codex 자체 이력·API 서비스의 원격 기록은 삭제 범위에 포함되지 않습니다.</p>}
    {error && <p role="alert" className="filter-errors">{error}</p>}
    <div className="dialog-actions">
      <button autoFocus disabled={busy} onClick={close}>{result ? '닫기' : '취소'}</button>
      {error && !result && <button onClick={() => { setError(''); setPlan(null); setRevision(value => value + 1); }}>다시 확인</button>}
      {!result && <button className="danger-button" disabled={busy || !plan?.deletableCount} onClick={() => void remove()}>{busy ? '일괄 삭제 중…' : `${plan?.deletableCount ?? 0}개 영구 삭제`}</button>}
    </div>
  </dialog>;
}
