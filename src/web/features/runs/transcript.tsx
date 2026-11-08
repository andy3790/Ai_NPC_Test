import { useState } from 'react';
import { aggregate } from '../../../core/metrics.js';
import { sourceUtteranceIds } from '../../../core/invocation-links.js';
import { visibleUtterance } from '../../../core/perception.js';
import type { RunDetail } from '../../../shared/types.js';
import { kinds, number, time, stamp, costText } from '../../shared/formatters.js';

export function Transcript({ detail }: { detail: RunDetail }) {
  const [observer, setObserver] = useState(''), [location, setLocation] = useState('');
  const map = detail.run.spec.scenario.spatial;
  const spatial = detail.run.variant.environmentMode === 'ai_spatial';
  const known = new Set(detail.receipts.filter(r => r.characterId === observer && r.status === 'delivered').map(r => r.utteranceId));
  const rows = detail.utterances.filter(u => !observer || u.speakerId === observer || known.has(u.id))
    .filter(u => !location || u.perception?.locationId === location || u.perception?.audience?.locationIds.includes(location))
    .map(u => observer && u.speakerId !== observer ? visibleUtterance(u, observer) : u);
  const place = (id: string | null) => map?.locations.find(l => l.id === id)?.name ?? (id || '통로·원격·공통');
  return <div className="transcript">
    {spatial && <div className="observation-filters"><label>관찰 관점<select aria-label="관찰 관점" value={observer} onChange={e => setObserver(e.target.value)}><option value="">관리자 · 전체 기록</option>{detail.run.spec.scenario.characters.map(c => <option key={c.id} value={c.id}>{c.name}이 받은 기록</option>)}</select></label><label>발생 장소<select aria-label="발생 장소" value={location} onChange={e => setLocation(e.target.value)}><option value="">모든 장소</option>{map?.locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label><small>{observer ? '본인 선택과 수신 완료한 내용만 표시합니다. 아직 수신함에 남은 내용은 제외합니다.' : '귓속말·서로 다른 장소의 기록도 포함한 관리자 화면입니다.'}</small></div>}
    {!rows.length && <div className="blank">{detail.utterances.length ? '이 조건에서 확인할 기록이 없습니다.' : 'NPC 세션을 준비하고 있습니다.'}</div>}
    {detail.run.completionReason === 'conversation_idle' && <div className="narrator">모두 발언과 행동 없이 차례를 넘겨 대화를 마쳤습니다.</div>}
    {detail.run.completionReason === 'conversation_withdrawn' && <div className="narrator">한 인물이 대화를 끊었고 상대의 마지막 반응까지 기록했습니다.</div>}
    {rows.map(u => {
      const call = detail.invocations.find(c => c.id === u.invocationId);
      const receivers = detail.invocations.filter(c => c.kind === 'receive' && c.sourceUtteranceId === u.id);
      const receipts = detail.receipts.filter(r => r.utteranceId === u.id);
      const worldCalls = detail.invocations.filter(c => c.kind === 'environment' && sourceUtteranceIds(c).includes(u.id));
      const shared = worldCalls.some(c => sourceUtteranceIds(c).length > 1);
      const worldStats = aggregate(worldCalls, detail.run.adapter);
      const color = detail.run.spec.scenario.characters.findIndex(c => c.id === u.speakerId);
      return u.kind === 'event' ? <div className="narrator" key={u.id}><span>{u.worldEvent ? `${u.speakerName} · 가상 ${number(u.worldEvent.virtualSeconds)}초` : u.resolution ? `환경 결과 · ${u.resolution.actionId}` : observer && detail.run.sceneObservationVersion ? '현장 관찰' : '상황 투입'}{u.perception && ` · ${place(u.perception.locationId)}`}</span>{u.speech}</div> :
        <article className="message" key={u.id}><span className={`avatar c${color % 5}`}>{u.speakerName[0]}</span><div className="message-body"><header><strong>{u.speakerName}</strong><span>#{String(u.speechIndex).padStart(3, '0')}</span><time>{stamp(u.createdAt)}</time></header>
          {u.perception && <div className="spatial-message-meta">가상 {number(u.perception.virtualSeconds)}초 · {place(u.perception.locationId)} · {u.spatialIntent ? ({ local: '현장 대화', whisper: '귓속말', channel: '원격 통신', none: '무발언 행동' })[u.spatialIntent.communication.mode] : '관찰 기록'}{u.spatialIntent?.activityChoice === 'cancel' && ' · 본인 행동 중단'}{u.spatialIntent?.activityChoice === 'continue' && ' · 기존 행동 계속'}</div>}
          {!observer && u.speech.trim() && u.perception?.speechRecipientIds.length === 0 && <div className="spatial-message-meta">들은 사람 없음</div>}
          {!u.action.trim() && u.spatialIntent?.moveToLocationId && <div className="action-text">이동 시도 · {place(u.spatialIntent.moveToLocationId)}</div>}
          {!u.speech.trim() && !u.action.trim() && !u.actionId && !u.spatialIntent?.moveToLocationId && u.spatialIntent?.activityChoice !== 'cancel' && <div className="action-text">발언·행동 없이 차례를 넘김</div>}
          {u.action && <div className="action-text">{u.action}</div>}{u.speech && <p>{u.speech}</p>}<footer><span>{number(call?.usage.totalTokens)} tokens</span><span>{time(call?.durationMs)}</span><span>수신 {receipts.filter(r => r.status === 'delivered').length}/{receipts.length}{receivers.length > 0 && ` · ${number(aggregate(receivers).tokens.totalTokens)} tokens`}</span>
            {worldCalls.length > 0 && <span title={shared ? '여러 행동을 함께 처리한 호출입니다. 묶음 총합에서는 한 번만 계산합니다.' : undefined}>세계 엔진 {shared && '(공동 처리) '}{number(worldStats.tokens.totalTokens)} tokens · {time(worldStats.durationSumMs)} · {costText(worldStats.cost)}</span>}
          </footer></div></article>;
    })}
    {detail.run.status === 'running' && <div className="working"><span className="pulse"/> {detail.invocations.findLast(c => c.status === 'running') ? `${kinds[detail.invocations.findLast(c => c.status === 'running')!.kind]} 진행 중` : '다음 단계 준비 중'}</div>}
  </div>;
}
