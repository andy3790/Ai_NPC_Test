import type { RunListItem } from '../../../shared/types.js';
import { delivery, providers, date } from '../../shared/formatters.js';
import { api } from '../../api/client.js';
import { Icon, Badge } from '../../shared/ui.js';

export function ExportView({ runs }: { runs: RunListItem[] }) {
  return <><div className="panel export-intro"><Icon name="download" size={34}/><div><h2>원본부터 분석 테이블까지, 하나의 ZIP으로.</h2><p>JSONL 원본 · 발화 CSV · 호출 CSV · 수신 CSV · 평가 CSV · 요약 CSV · 설정 JSON · 대화록 · 데이터 사전</p></div></div><div className="panel table-wrap"><table><thead><tr><th>대화 묶음</th><th>전달 방식</th><th>발화</th><th>상태</th><th>다운로드</th></tr></thead><tbody>{runs.map(r => <tr key={r.id}><td>{r.name}<small>{providers[r.adapter]} · {r.history?.readOnly ? '보관본' : '현재 저장소'}</small><small>{date(r.createdAt)} · {r.id}</small></td><td>{delivery[r.variant.deliveryMode]}</td><td>{r.summary.speechCount}</td><td><Badge status={r.status}/></td><td><a className="download-link" href={api.exportUrl(r.id)}><Icon name="download" size={16}/> ZIP</a></td></tr>)}</tbody></table>{!runs.length && <div className="blank">실험을 실행하면 분석 데이터를 내보낼 수 있습니다.</div>}</div></>;
}
