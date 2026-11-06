import type { RunDetail } from '../../../shared/types.js';
import { stamp } from '../../shared/formatters.js';

export function Receipts({ detail }: { detail: RunDetail }) {
  const messages = new Map(detail.utterances.map(u => [u.id, u]));
  const calls = new Map(detail.invocations.map(c => [c.id, c]));
  const names = new Map(detail.run.spec.scenario.characters.map(c => [c.id, c.name]));
  const together = new Map<string, number[]>();
  for (const receipt of detail.receipts) if (receipt.invocationId) {
    const sequences = together.get(receipt.invocationId) ?? [];
    const sequence = messages.get(receipt.utteranceId)?.sequence;
    if (sequence !== undefined) sequences.push(sequence);
    together.set(receipt.invocationId, sequences);
  }
  return <div><p className="form-hint">수신 기록 {detail.receipts.length}개 · 수신 전용 호출 {detail.invocations.filter(c => c.kind === 'receive').length}회. 같은 호출로 함께 전달한 내용도 원본별로 표시합니다.</p>
    <div className="table-wrap"><table><thead><tr><th>원본 순번</th><th>원본 내용</th><th>수신 NPC</th><th>전달</th><th>처리</th><th>완료 시간</th></tr></thead><tbody>{detail.receipts.map(r => {
      const u = messages.get(r.utteranceId), call = r.invocationId ? calls.get(r.invocationId) : undefined;
      const shared = r.invocationId ? together.get(r.invocationId) ?? [] : [];
      const source = u?.kind === 'speech' ? `${u.speakerName} 발화 #${u.speechIndex}` : u?.resolution ? `발화 #${u.resolution.speechIndex} 환경 결과` : u?.worldEvent ? '세계 관찰' : '상황 투입';
      return <tr key={r.id}><td>#{u?.sequence}</td><td title={u ? [u.speech, u.action].filter(Boolean).join('\n') : undefined}>{source}</td><td>{names.get(r.characterId)}</td>
        <td>{call?.kind === 'speech' ? '발화 때 함께 반영' : shared.length > 1 ? `함께 수신 (${shared.map(n => '#' + n).join(' · ')})` : call ? '개별 수신' : '—'}</td>
        <td>{r.status === 'delivered' ? '수신 완료' : r.status === 'processing' ? '처리 중' : '수신함 대기'}</td><td>{r.deliveredAt ? stamp(r.deliveredAt) : '—'}</td></tr>;
    })}</tbody></table></div></div>;
}
