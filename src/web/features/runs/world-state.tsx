import { environmentMode } from '../../../shared/schema.js';
import type { RunDetail } from '../../../shared/types.js';
import { costText, environmentModes, number, time } from '../../shared/formatters.js';

export function WorldStateView({ detail }: { detail: RunDetail }) {
  const { run } = detail; const mode = environmentMode(run.spec, run.variant); const state = run.worldState;
  if (!['ai', 'ai_spatial'].includes(mode)) return <div className="blank">환경 방식: {environmentModes[mode]}<br/><small>AI 세계 상태는 AI 세계 엔진을 선택한 묶음에서 기록됩니다.</small></div>;
  const stats = detail.summary.byKind.environment;
  const name = (id: string) => run.spec.scenario.characters.find(c => c.id === id)?.name ?? id;
  const pending = state?.processes.filter(p => p.status === 'pending') ?? [];
  const spatial = state?.spatial, map = run.spec.scenario.spatial;
  const place = (id: string | null) => map?.locations.find(l => l.id === id)?.name ?? id ?? '통로';
  const generatorStats = detail.summary.byKind.event_generation;
  return <div className="run-settings world-state">
    <h3>세계 상태 · 시작 후 {number(state?.virtualSeconds ?? 0)}초</h3>
    <p className="snapshot-note">AI가 말·행동의 길이를 판단한 가상 시간입니다. 실제 응답 시간과 다릅니다. 예정 사건은 아직 일어나지 않은 내용이며 NPC에게 전달되지 않습니다.</p>
    <dl className="snapshot-meta"><dt>엔진 모델</dt><dd>{run.spec.worldEngine?.model} / {run.spec.worldEngine?.effort}</dd>
      <dt>처리한 공개 발화</dt><dd>{state?.processedSpeechCount ?? 0} / {detail.summary.speechCount}</dd>
      <dt>엔진 호출 · 토큰</dt><dd>{stats?.calls ?? 0}회 · {number(stats?.tokens.totalTokens)} tokens</dd>
      <dt>엔진 환산 비용</dt><dd>{costText(stats?.cost)}</dd><dt>엔진 응답 중앙값 / P95</dt><dd>{time(stats?.medianMs)} / {time(stats?.p95Ms)}</dd>
    </dl>
    {spatial && <section><h3>현재 위치와 진행 중 행동</h3><div className="spatial-places">{map?.locations.map(l => <article className="world-process" key={l.id}><strong>{l.name}</strong><p>{spatial.positions.filter(p => p.locationId === l.id).map(p => name(p.npcId)).join(', ') || '현재 인원 없음'}</p></article>)}</div>
      {spatial.positions.filter(p => p.transit).map(p => <p key={p.npcId}>{name(p.npcId)} · {place(p.transit!.from)} ↔ {place(p.transit!.to)} 통로 {spatial.activities.some(a => a.id === p.transit!.activityId && a.status === 'pending') ? '이동 중' : '머무는 중'}</p>)}
      {spatial.activities.filter(a => a.status === 'pending').map(a => <article className="world-process" key={a.id}><strong>{name(a.npcId)} · {a.kind === 'reaction' ? '반응' : '행동'}</strong><p>{detail.utterances.find(u => u.id === a.sourceUtteranceId)?.action || '대화'}</p><small>가상 {number(a.startedAtSeconds)}초 시작 → {number(a.readyAtSeconds)}초부터 결과 처리 가능</small>{a.waitingNpcIds.length > 0 && <p className="world-reaction">우선 반응 대기: {a.waitingNpcIds.map(name).join(', ')}</p>}</article>)}
      <details><summary>완료·중단·실패한 행동</summary>{spatial.activities.filter(a => a.status !== 'pending').map(a => <p key={a.id}>{name(a.npcId)} · {({ completed: '완료', cancelled: '본인이 중단', failed: '실패', pending: '진행 중' })[a.status]} · {number(a.finishedAtSeconds)}초 · {a.reason}</p>)}</details>
    </section>}
    {run.variant.eventGeneration && <section><h3>상황 발생 · 관리자 기록</h3><p>{generatorStats?.calls ?? 0}회 · {number(generatorStats?.tokens.totalTokens)} tokens · {costText(generatorStats?.cost)}</p><p className="snapshot-note">제안은 검토 후 채택된 관찰 내용만 NPC에게 전달합니다. 미채택 제안과 내부 예정 사건은 관리자만 볼 수 있습니다.</p>{run.eventGeneratorState?.proposals.map(p => <article className="world-process" key={p.id}><strong>{p.title}</strong><p>{p.description}</p><small>가상 {number(p.virtualSeconds)}초 · {p.severity} · {({ proposed: '검토 대기', accepted: '채택', rejected: '거절' })[p.status]} · {p.reason}</small></article>)}</section>}
    <section><h3>현재 확인된 상태</h3>{state?.facts.length ? <ul>{state.facts.map(f => <li key={f.id}><strong>{f.scope === 'npc_physical' ? `${name(f.npcId!)} · 물리 상태` : '환경'}</strong> · {f.text}</li>)}</ul> : <p>추가로 확정된 상태가 없습니다. 최초 세계관과 시작 상황은 실행 설정에서 확인하세요.</p>}</section>
    <section><h3>진행 중 사건 {pending.length}개</h3>{pending.length ? pending.map(p => <article className="world-process" key={p.id}><strong>{p.description}</strong><p>처리 가능 시각: 시작 후 {number(p.readyAtSeconds)}초{p.readyAtSeconds <= (state?.virtualSeconds ?? 0) && ' · 시각 도달'}</p>
      {p.waitingNpcIds.length > 0 && <p className="world-reaction">우선 반응 대기: {p.waitingNpcIds.map(name).join(', ')} · 기회 제공 전 결과 보류</p>}
      {p.offeredNpcIds.length > 0 && <small>반응 기회 제공됨: {p.offeredNpcIds.map(name).join(', ')}</small>}
    </article>) : <p>없음</p>}</section>
    {state?.processes.some(p => p.status !== 'pending') && <details><summary>종료된 사건</summary><ul>{state.processes.filter(p => p.status !== 'pending').map(p => <li key={p.id}>{p.description} · {p.status === 'completed' ? '완료' : '취소'} ({number(p.finishedAtSeconds)}초) — {p.reason}</li>)}</ul></details>}
    <p className="snapshot-note">발화 한도는 무발언 행동도 포함한 NPC 선택 횟수입니다. 한 발화 진행은 선택 1회·시간 계획·현재 시각에 가능한 결과·수신 처리까지 포함합니다. 미래의 긴 행동은 진행 중으로 남을 수 있습니다. 한도에 도달하면 미래 사건을 남긴 채 종료합니다.</p>
  </div>;
}
