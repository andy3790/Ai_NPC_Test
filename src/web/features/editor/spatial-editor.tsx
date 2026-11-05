import type { ExperimentSpec } from '../../../shared/schema.js';

type Props = { spec: ExperimentSpec; update: (fn: (s: ExperimentSpec) => void) => void };
export function SpatialEditor({ spec, update }: Props) {
  const map = spec.scenario.spatial;
  const edit = (fn: (m: NonNullable<ExperimentSpec['scenario']['spatial']>) => void) => update(s => { fn(s.scenario.spatial!); });
  const places = (value: string, change: (id: string) => void, label: string) => <select aria-label={label} value={value} onChange={e => change(e.target.value)}><option value="">장소 선택</option>{map?.locations.map((l, i) => <option key={i} value={l.id}>{l.name || l.id}</option>)}</select>;
  return <section className="spatial-editor form-stack"><h3>분산 공간 · 장소와 통신</h3>
    <p className="form-hint">장소·통로·시작 위치를 미리 정합니다. 실험 조건에서 ‘AI 분산 공간’을 선택하면 사용합니다. 공통 시작 상황은 모두가 알고, 장소별 시작 상황은 처음 그곳에 있는 NPC만 압니다.</p>
    {!map ? <button onClick={() => update(s => { s.scenario.spatial = { locations: [], connections: [], initialPositions: [], channels: [] }; })}>장소 설정 추가</button> : <>
      {map.locations.map((l, i) => <article className="spatial-edit-row" key={i}><div className="form-grid">
        <label>장소 ID<input aria-label={`장소 ${i + 1} ID`} value={l.id} onChange={e => edit(m => { const old = m.locations[i].id, id = e.target.value; m.locations[i].id = id; m.connections.forEach(r => { if (r.from === old) r.from = id; if (r.to === old) r.to = id; }); m.initialPositions.forEach(p => { if (p.locationId === old) p.locationId = id; }); })}/></label>
        <label>장소 이름<input aria-label={`장소 ${i + 1} 이름`} value={l.name} onChange={e => edit(m => { m.locations[i].name = e.target.value; })}/></label>
        <label>장소 설명<textarea aria-label={`장소 ${i + 1} 설명`} value={l.description} onChange={e => edit(m => { m.locations[i].description = e.target.value; })}/></label>
        <label>현장 시작 상황<textarea aria-label={`장소 ${i + 1} 시작 상황`} value={l.initialSituation} onChange={e => edit(m => { m.locations[i].initialSituation = e.target.value; })}/></label>
      </div><button onClick={() => edit(m => { m.locations.splice(i, 1); m.connections = m.connections.filter(r => r.from !== l.id && r.to !== l.id); m.initialPositions = m.initialPositions.filter(p => p.locationId !== l.id); })}>장소 삭제</button></article>)}
      <button onClick={() => edit(m => { let n = 1; while (m.locations.some(l => l.id === `place-${n}`)) n++; m.locations.push({ id: `place-${n}`, name: '', description: '', initialSituation: '' }); })}>+ 장소 추가</button>
      <h4>연결 통로</h4>{map.connections.map((r, i) => <article className="spatial-edit-row" key={i}><div className="form-grid">
        <label>통로 ID<input aria-label={`통로 ${i + 1} ID`} value={r.id} onChange={e => edit(m => { m.connections[i].id = e.target.value; })}/></label>
        <label>출발 장소{places(r.from, id => edit(m => { m.connections[i].from = id; }), `통로 ${i + 1} 출발`)}</label>
        <label>도착 장소{places(r.to, id => edit(m => { m.connections[i].to = id; }), `통로 ${i + 1} 도착`)}</label>
        <label>통로 설명<input value={r.description} onChange={e => edit(m => { m.connections[i].description = e.target.value; })}/></label>
      </div><label className="checkbox"><input type="checkbox" checked={r.bidirectional} onChange={e => edit(m => { m.connections[i].bidirectional = e.target.checked; })}/>양방향 이동</label><button onClick={() => edit(m => { m.connections.splice(i, 1); })}>통로 삭제</button></article>)}
      <button onClick={() => edit(m => { let n = 1; while (m.connections.some(r => r.id === `route-${n}`)) n++; m.connections.push({ id: `route-${n}`, from: '', to: '', description: '', bidirectional: true }); })}>+ 통로 추가</button>
      <h4>NPC 시작 위치</h4><div className="form-grid">{spec.scenario.characters.map(c => <label key={c.id}>{c.name}{places(map.initialPositions.find(p => p.npcId === c.id)?.locationId ?? '', id => edit(m => { m.initialPositions = m.initialPositions.filter(p => p.npcId !== c.id && spec.scenario.characters.some(c => c.id === p.npcId)); if (id) m.initialPositions.push({ npcId: c.id, locationId: id }); }), `${c.name} 시작 위치`)}</label>)}</div>
      <h4>원격 통신 채널</h4>{map.channels.map((c, i) => <article className="spatial-edit-row" key={i}><div className="form-grid">
        <label>채널 ID<input value={c.id} onChange={e => edit(m => { m.channels[i].id = e.target.value; })}/></label>
        <label>채널 이름<input value={c.name} onChange={e => edit(m => { m.channels[i].name = e.target.value; })}/></label>
        <label>통신 방식·제약 설명<input value={c.description} onChange={e => edit(m => { m.channels[i].description = e.target.value; })}/></label>
      </div><div className="spatial-members">{spec.scenario.characters.map(npc => <label className="checkbox" key={npc.id}><input type="checkbox" checked={c.memberNpcIds.includes(npc.id)} onChange={e => edit(m => { m.channels[i].memberNpcIds = e.target.checked ? [...c.memberNpcIds, npc.id] : c.memberNpcIds.filter(id => id !== npc.id); })}/>{npc.name}</label>)}</div><button onClick={() => edit(m => { m.channels.splice(i, 1); })}>채널 삭제</button></article>)}
      <button onClick={() => edit(m => { let n = 1; while (m.channels.some(c => c.id === `channel-${n}`)) n++; m.channels.push({ id: `channel-${n}`, name: '', description: '', memberNpcIds: [] }); })}>+ 채널 추가</button>
      <p className="form-hint">같은 장소에서도 귓속말은 지정 대상만 듣습니다. 겉으로 보이는 행동은 현장에 공유됩니다. 원격 채널은 대사만 전달하며 상대 공간의 모습은 보여 주지 않습니다.</p>
    </>}
  </section>;
}
