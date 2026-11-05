import { useEffect, useRef, useState } from 'react';
import type { RunDeletionPlan } from '../../../shared/types.js';
import { api, errorMessage } from '../../api/client.js';

export function DeleteRunDialog({ id, close, onDeleted }: { id: string; close: () => void; onDeleted: (id: string) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [plan, setPlan] = useState<RunDeletionPlan | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    ref.current?.showModal();
    void api.deletionPlan(id).then(value => { if (!cancelled) setPlan(value); }).catch(error => { if (!cancelled) setError(errorMessage(error)); });
    return () => { cancelled = true; ref.current?.close(); };
  }, [id]);
  const remove = async () => {
    if (!plan?.allowed || busy) return;
    setBusy(true); setError('');
    try { await api.deleteRun(id, plan.token); onDeleted(id); close(); }
    catch (error) { setError(errorMessage(error)); setPlan(null); }
    finally { setBusy(false); }
  };
  const labels = { database: 'DB 내 해당 묶음', archive: '통합 보관본', export: '내보낸 파일', session: '로컬 세션 기록' };
  return <dialog className="delete-dialog" ref={ref} aria-labelledby="delete-title" onCancel={event => { event.preventDefault(); if (!busy) close(); }}>
    <h2 id="delete-title">대화 묶음을 영구 삭제할까요?</h2>
    {plan ? <><strong className="delete-run-name">{plan.name}</strong><p>공개 발화 {plan.speechCount}건, 호출 {plan.invocationCount}건과 수신·평가·계측·실행 설정을 실제로 삭제합니다. 복구할 수 없습니다.</p>
      <p className="snapshot-note">확인된 저장 위치의 해당 묶음만 삭제합니다. 별도로 복사한 파일, 다운로드한 ZIP, Codex 자체 이력과 API 서비스의 원격 기록은 삭제 범위에 포함되지 않습니다.</p>
      <details open><summary>삭제 대상 {plan.targets.length}곳</summary><ul>{plan.targets.map(target => <li key={target.path}><span>{labels[target.kind]}</span><code>{target.path}</code></li>)}</ul></details>
      {plan.blockers.map(blocker => <p className="filter-errors" key={blocker}>{blocker}</p>)}</> : !error && <p role="status">원본과 보관본을 확인하고 있습니다…</p>}
    {error && <p role="alert" className="filter-errors">{error}</p>}
    <div className="dialog-actions"><button autoFocus disabled={busy} onClick={close}>취소</button><button className="danger-button" disabled={busy || !plan?.allowed} onClick={() => void remove()}>{busy ? '삭제 중…' : '영구 삭제'}</button></div>
  </dialog>;
}
