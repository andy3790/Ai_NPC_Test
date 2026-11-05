import { useEffect, useState } from 'react';
import type { ApiKeyStatus } from '../../../shared/types.js';
import { api, errorMessage } from '../../api/client.js';

export function ApiKeySettings({ status, onChanged }: { status: ApiKeyStatus | null; onChanged: () => Promise<void> }) {
  const [expanded, setExpanded] = useState(false);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => { if (status?.source === 'missing') setExpanded(true); }, [status?.source]);
  const save = async (clear = false) => {
    setBusy(true); setError(''); setNotice('');
    try {
      if (clear) await api.clearApiKey(); else await api.setApiKey(key);
      setKey('');
      setNotice(clear ? '개인 키 선택을 해제했습니다. 새 실험에는 서버 환경 키가 있으면 사용합니다.' : '개인 키를 적용했습니다. 이 브라우저에서 만드는 새 실험에 사용합니다.');
      try { await onChanged(); } catch (e) { setError(`키 설정은 변경했지만 연결 정보를 갱신하지 못했습니다: ${errorMessage(e)}`); }
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  };
  return <section className={`api-key-settings${status?.source === 'missing' ? ' needs-key' : ''}`} aria-label="OpenAI API 키 설정">
    <div className="api-key-heading"><div><strong>OpenAI API · {status?.source === 'browser' ? '개인 키 사용 중' : status?.source === 'environment' ? '서버 환경 키 사용 중' : status ? 'API 키 입력 필요' : '키 설정 확인 중'}</strong>
      <p>{!status ? '이 브라우저에서 사용할 API 키 설정을 확인하고 있습니다.' : status.configured ? '이 서버의 실험은 API 사용량이 발생합니다. 개인 키가 없으면 서버의 .env 키를 사용합니다.' : '개인 키와 서버 환경 키가 없습니다. 실험을 시작하려면 API 키를 입력해 주세요. 기존 기록은 계속 볼 수 있습니다.'}</p></div>
      <button aria-expanded={expanded} aria-controls="api-key-form" onClick={() => { setExpanded(value => !value); setKey(''); setError(''); setNotice(''); }}>{expanded ? '키 설정 닫기' : 'API 키 설정'}</button></div>
    {expanded && <form id="api-key-form" onSubmit={event => { event.preventDefault(); if (!busy && key.trim()) void save(); }}>
      <label htmlFor="personal-api-key">개인 OpenAI API 키</label>
      <div className="api-key-input-row"><input id="personal-api-key" type="password" value={key} onChange={event => setKey(event.target.value)} placeholder="API 키 전체를 입력하세요" autoComplete="off" spellCheck={false} maxLength={4096} disabled={busy || !status}/>
        <button className="primary" type="submit" disabled={busy || !status || !key.trim()}>{busy ? '확인 중…' : '키 확인 후 적용'}</button>
        {status?.source === 'browser' && <button type="button" disabled={busy} onClick={() => void save(true)}>개인 키 해제</button>}</div>
      <p className="api-key-help">키는 서버 메모리에만 보관하며 서버 재시작 시 다시 입력합니다. .env 파일과 브라우저 저장소에는 쓰지 않습니다. 적용 전에 모델 목록으로 연결을 확인합니다.</p>
      <p className="api-key-help">기존 실험은 생성 당시 키를 계속 사용합니다. 키 교체·해제는 새 실험부터 적용되며, 기존 실험의 키도 서버 종료 시 메모리에서 사라집니다.</p>
      {error && <p role="alert" className="red">{error}</p>}{notice && <p role="status">{notice}</p>}
    </form>}
  </section>;
}
