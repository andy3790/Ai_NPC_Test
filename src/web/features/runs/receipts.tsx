import type { RunDetail } from '../../../shared/types.js';
import { stamp } from '../../shared/formatters.js';

export function Receipts({ detail }: { detail: RunDetail }) {
  return <div className="table-wrap"><table><thead><tr><th>원본 순번</th><th>수신 NPC</th><th>처리</th><th>완료 시간</th></tr></thead><tbody>{detail.receipts.map(r => <tr key={r.id}><td>#{detail.utterances.find(u => u.id === r.utteranceId)?.sequence}</td><td>{detail.run.spec.scenario.characters.find(c => c.id === r.characterId)?.name}</td><td>{r.status === 'delivered' ? '수신 완료' : r.status === 'processing' ? '처리 중' : '수신함 대기'}</td><td>{r.deliveredAt ? stamp(r.deliveredAt) : '—'}</td></tr>)}</tbody></table></div>;
}
