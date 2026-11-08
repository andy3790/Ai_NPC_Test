import { useEffect, useState } from 'react';
import type { RunDetail } from '../../../shared/types.js';
import type { Audience } from '../../../shared/spatial-schema.js';
import { providers, date } from '../../shared/formatters.js';
import { Icon, Badge } from '../../shared/ui.js';
import { api, type FindingPatch, type RunControl } from '../../api/client.js';
import { Transcript } from './transcript.js';
import { Calls } from './calls.js';
import { Findings } from './findings.js';
import { Receipts } from './receipts.js';
import { RunInspector } from './run-inspector.js';
import { RunSettings } from './run-settings.js';
import { WorldStateView } from './world-state.js';

interface RunWorkspaceProps {
  detail: RunDetail; busy: boolean;
  tab: string; setTab: (tab: string) => void;
  eventText: string; setEventText: (text: string) => void;
  onControl: (control: RunControl) => void;
  onInject: (text: string, audience?: Audience, observation?: string) => Promise<boolean>;
  onReview: (id: string, patch: FindingPatch) => void;
  onCompare: () => void;
  onDelete: () => void;
}

export function RunWorkspace({ detail, busy, tab, setTab, eventText, setEventText, onControl, onInject, onReview, onCompare, onDelete }: RunWorkspaceProps) {
  const [eventScope, setEventScope] = useState('all');
  const [eventNote, setEventNote] = useState('');
  useEffect(() => { setEventNote(''); setEventScope('all'); }, [detail.run.id]);
  const eventAudience: Audience = eventScope.startsWith('location:') ? { scope: 'locations', locationIds: [eventScope.slice(9)], npcIds: [] } : eventScope.startsWith('npc:') ? { scope: 'npcs', npcIds: [eventScope.slice(4)], locationIds: [] } : { scope: 'all', locationIds: [], npcIds: [] };
  return <div className="workspace-grid"><section className="panel conversation"><div className="panel-header"><div><span className="eyebrow">LIVE SESSION</span><h2>{detail.run.spec.scenario.name}</h2></div><div className="panel-actions"><Badge status={detail.run.status}/><button className="icon-button" title="데이터 ZIP 다운로드" onClick={() => { window.location.href = api.exportUrl(detail.run.id); }}><Icon name="download" size={17}/></button></div></div>
              <div className="record-origin"><strong>{providers[detail.run.adapter]} · {detail.history?.readOnly ? '보관 기록 · 조회·비교·내보내기' : '현재 저장소'}</strong><span>{date(detail.run.createdAt)} · {detail.run.id}</span><details><summary>저장 위치 {detail.history?.locations.length ?? 1}곳</summary>{detail.history?.locations.map(path => <code key={path}>{path}</code>)}{detail.history?.archivedAt && <small>보관 갱신 {date(detail.history.archivedAt)}</small>}</details>{detail.history?.readOnly && <small>실행 상태와 평가는 저장 당시의 값입니다. 실행 제어·평가 검토는 원본 저장소의 서버에서 할 수 있습니다.</small>}</div><div className="session-strip">{Object.values(detail.run.sessions).map((s, i) => <div key={s.id}><span className={`avatar c${i % 5}`}>{detail.run.spec.scenario.characters.find(c => c.id === s.characterId)?.name[0]}</span><span>{s.config.model}<small>{s.config.effort}</small></span></div>)}</div>
              <div className="tabs">{[['dialogue', '대화 기록'], ['calls', '호출·계측'], ['findings', `평가 결과 ${detail.findings.length}`], ['receipts', '수신 상태'], ['world', '세계 상태'], ['settings', '실행 설정']].map(([key, text]) => <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{text}</button>)}</div>
              {tab === 'dialogue' && <Transcript detail={detail}/>}
              {tab === 'calls' && <Calls calls={detail.invocations} adapter={detail.run.adapter}/>}
              {tab === 'findings' && <Findings detail={detail} onReview={onReview} showDialogue={() => setTab('dialogue')}/>}
              {tab === 'receipts' && <Receipts detail={detail}/>}
              {tab === 'settings' && <RunSettings detail={detail}/>}
              {tab === 'world' && <WorldStateView detail={detail}/>}
              <div className="run-delete-row"><span>이 묶음의 원본·보관 기록 관리</span><button className="danger-button" disabled={busy} onClick={onDelete}>기록 삭제</button></div>
              {detail.run.error && <div className="run-error">{detail.run.error}</div>}
              {!detail.history?.readOnly && <><div className="controls"><div><button disabled={busy || detail.run.status !== 'paused'} onClick={() => onControl('resume')}><Icon name="play" size={14}/> 재개</button><button disabled={busy || !['running', 'queued'].includes(detail.run.status)} onClick={() => onControl('pause')}>{detail.run.pauseRequested ? '일시정지 대기…' : '일시정지'}</button><button disabled={busy || detail.run.status !== 'paused'} onClick={() => onControl('step')}>한 발화 진행</button><button disabled={busy || ['completed', 'stopped'].includes(detail.run.status)} onClick={() => onControl('stop')}>중단</button></div><button disabled={busy || ['running', 'queued'].includes(detail.run.status)} onClick={() => onControl('evaluate')}>평가 실행</button></div>
              <div className="inject">{detail.run.variant.environmentMode === 'ai_spatial' && <select aria-label="상황 관찰 범위" value={eventScope} onChange={e => setEventScope(e.target.value)}><option value="all">모든 NPC</option>{detail.run.spec.scenario.spatial?.locations.map(l => <option key={l.id} value={`location:${l.id}`}>{l.name} 현장</option>)}{detail.run.spec.scenario.characters.map(c => <option key={c.id} value={`npc:${c.id}`}>{c.name}만</option>)}</select>}<input aria-label="새 상황" placeholder="인물이 보거나 듣는 변화 (예: 복도에서 의자 끄는 소리가 난다)" value={eventText} onChange={e => setEventText(e.target.value)} disabled={detail.run.status !== 'paused'}/><button disabled={busy || detail.run.status !== 'paused' || !eventText.trim()} onClick={() => void onInject(eventNote.trim() || eventText, detail.run.variant.environmentMode === 'ai_spatial' ? eventAudience : undefined, eventNote.trim() ? eventText : undefined).then(saved => { if (saved) { setEventText(''); setEventNote(''); } })}>투입 <Icon name="arrow" size={15}/></button></div><details><summary>운영 메모 (선택)</summary><input aria-label="운영 메모" placeholder="이 실행의 검토 기록에만 남길 내용" value={eventNote} onChange={e => setEventNote(e.target.value)} disabled={detail.run.status !== 'paused'}/></details></>}
            </section><RunInspector detail={detail} onCompare={onCompare}/></div>;
}
