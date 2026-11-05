import type { RunDetail } from '../../../shared/types.js';
import { percent } from '../../shared/formatters.js';

export function Quality({ detail }: { detail: RunDetail }) {
  const q = detail.summary.quality;
  if (!q) return null;
  return <section className="panel quality-panel"><div className="mini-title"><h3>반복·목표 평가</h3></div><dl>
    <dt>어휘 반복률</dt><dd>{percent(q.repetition.rate)} ({q.repetition.repeatedSpeeches}/{q.repetition.eligibleSpeeches})</dd>
    <dt>AI 의미 반복 지적률</dt><dd>{percent(q.semanticRepetition.rate)}</dd>
    <dt>목표 달성</dt><dd>{q.progression ? `${q.progression.achievedGoals}/${q.progression.totalGoals}` : '목표 미정의'}</dd>
    {q.progression && <><dt>상태 변화 없는 발화</dt><dd>최근 {q.progression.stalledSpeechCount}회</dd></>}
  </dl>{q.progression?.goals.map(g => <p key={g.id}>{g.achieved ? '✓' : '○'} {g.label}<small>{g.firstAchievedAtSpeech !== null ? ` · 최초 #${g.firstAchievedAtSpeech}` : ' · 미달성'}</small></p>)}
    <small>어휘 반복률은 최근 {q.repetition.window}발화 안에서 같은 화자의 대사를 비교합니다. 유사도 {q.repetition.threshold} 이상 / 비교 가능한 발화. 행동 습관·짧은 응답은 제외합니다.</small>
    {q.progression && <details><summary>확정된 공개 상태</summary><pre>{JSON.stringify(q.progression.state, null, 2)}</pre></details>}
  </section>;
}
