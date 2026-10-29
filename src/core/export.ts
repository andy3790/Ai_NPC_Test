import { aggregate, groupedMetrics, tokenKeys } from './metrics.js';
import type { RunDetail, RawEvent } from '../shared/types.js';
function csv(rows: Record<string, unknown>[], columns?: string[]) {
  const keys = columns ?? [...new Set(rows.flatMap(r => Object.keys(r)))];
  const cell = (v: unknown) => { const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); return `"${s.replaceAll('"', '""')}"`; };
  return '\ufeff' + [keys.map(cell).join(','), ...rows.map(r => keys.map(k => cell(r[k])).join(','))].join('\r\n') + '\r\n';
}
export function exportFiles(detail: RunDetail, events: RawEvent[]): Record<string, string> {
  const { run, utterances, invocations, receipts, evaluations, findings, summary } = detail;
  const ids = { experimentId: run.experimentId, runId: run.id, variantId: run.variant.id, repetition: run.repetition, adapter: run.adapter, deliveryMode: run.variant.deliveryMode, memoryMode: run.variant.memoryMode };
  const calls = invocations.map(c => ({ ...c, ...c.usage, usage: undefined }));
  const messages = utterances.map(u => {
    const generated = invocations.filter(c => c.utteranceId === u.id);
    const listeners = invocations.filter(c => c.sourceUtteranceId === u.id);
    return { ...ids, ...u, generatedTokens: aggregate(generated).tokens.totalTokens, receiveTokens: aggregate(listeners).tokens.totalTokens, receiveCalls: listeners.length, generationMs: generated[0]?.durationMs ?? null, pendingRecipients: receipts.filter(r => r.utteranceId === u.id && r.status !== 'delivered').length };
  });
  const rows = [ { type: 'run', ...run }, ...utterances.map(v => ({ type: 'utterance', ...v })), ...receipts.map(v => ({ type: 'receipt', ...v })), ...invocations.map(v => ({ type: 'invocation', ...v })), ...evaluations.map(v => ({ type: 'evaluation', ...v })), ...findings.map(v => ({ type: 'finding', ...v })), ...events.map(v => ({ type: 'raw_event', ...v })) ];
  return {
    'records.jsonl': rows.map(r => JSON.stringify(r)).join('\n') + '\n',
    'utterances.csv': csv(messages, [...Object.keys(ids), 'id', 'sequence', 'speechIndex', 'kind', 'speakerId', 'speakerName', 'speech', 'action', 'actionId', 'resolution', 'createdAt', 'invocationId', 'generatedTokens', 'receiveTokens', 'receiveCalls', 'generationMs', 'deliveryMs', 'deliveryCompletedAt', 'pendingRecipients']),
    'invocations.csv': csv(calls, ['id', 'experimentId', 'runId', 'variantId', 'repetition', 'characterId', 'kind', 'operationKey', 'attempt', 'retryOf', 'threadId', 'turnId', 'sourceUtteranceId', 'utteranceId', 'model', 'effort', 'actualModel', 'deliveryMode', 'memoryMode', 'status', 'queuedAt', 'startedAt', 'firstOutputAt', 'completedAt', 'queueMs', 'firstOutputMs', 'durationMs', ...tokenKeys, 'usageStatus', 'error', 'input', 'output', 'metadata']),
    'receipts.csv': csv(receipts.map(r => ({ ...ids, ...r })), [...Object.keys(ids), 'id', 'utteranceId', 'characterId', 'status', 'invocationId', 'deliveredAt']),
    'summary.csv': csv([{ ...ids, name: run.name, status: run.status, snapshotHash: run.snapshotHash, ...summary, ...summary.tokens }]),
    'quality.json': JSON.stringify(summary.quality ?? null, null, 2),
    'repetition.csv': csv((summary.quality?.repetition.matches ?? []).map((m: any) => ({ ...ids, ...m })), [...Object.keys(ids), 'utteranceId', 'speechIndex', 'previousUtteranceId', 'previousSpeechIndex', 'similarity']),
    'goals.csv': csv((summary.quality?.progression?.goals ?? []).map((g: any) => ({ ...ids, ...g })), [...Object.keys(ids), 'id', 'label', 'conditions', 'achieved', 'firstAchievedAtSpeech']),
    'model-metrics.csv': csv(groupedMetrics(invocations).map(g => ({ ...ids, ...g, ...g.tokens }))),
    'evaluations.csv': csv(evaluations.map(e => ({ ...ids, ...e })), [...Object.keys(ids), 'id', 'from', 'to', 'status', 'contextTruncated', 'summary', 'quality', 'invocationId', 'error']),
    'findings.csv': csv(findings.map(f => ({ ...ids, ...f })), [...Object.keys(ids), 'id', 'evaluationId', 'utteranceId', 'category', 'severity', 'verdict', 'quote', 'reference', 'explanation', 'review', 'note']),
    'config.json': JSON.stringify({ schemaVersion: 1, ...ids, snapshotHash: run.snapshotHash, appVersion: run.appVersion, cliVersion: run.cliVersion, spec: run.spec, variant: run.variant, resolvedSessions: run.sessions }, null, 2),
    'transcript.md': `# ${run.name}\n\n- 상태: ${run.status}\n- 전달: ${run.variant.deliveryMode}\n- 기억: ${run.variant.memoryMode}\n- 묶음: ${run.id}\n\n` + utterances.map(u => `### ${u.kind === 'event' ? '상황' : `#${u.speechIndex}`} · ${u.speakerName}\n\n${u.speech}\n\n${u.action ? `*${u.action}*\n\n` : ''}`).join(''),
    'data-dictionary.md': `# 데이터 사전 · schemaVersion 1\n\n모든 시각은 UTC ISO 8601, 시간 간격은 밀리초입니다. CSV는 UTF-8 BOM 및 RFC 4180 인용 규칙을 사용합니다. 빈 수치 셀은 미제공(null)이며 0이 아닙니다. JSONL에는 원본 값과 원본 사용량 이벤트가 보존됩니다.\n\n- runId / experimentId / variantId / repetition: 묶음, 실험, 조건, 반복 식별자.\n- speechIndex: 공개 NPC 발화 번호. sequence는 상황 투입도 포함합니다.\n- kind: speech=공개 발화, receive=수신 처리, director=진행자, evaluation=평가.\n- receipt: 발화별 수신자 상태. 모아 전달 모드는 종료 시 pending이 남을 수 있습니다.\n- sourceUtteranceId: 수신 호출을 유발한 공개 발화. batched 전달의 수신 연결은 receipts.csv의 invocationId를 이용합니다.\n- operationKey / attempt / retryOf: 논리 작업, 호출 시도, 이전 시도. 실패 비용도 합계에 포함됩니다.\n- inputTokens / outputTokens / totalTokens: Codex가 보고한 누적 카운터 차이. 캐시 입력과 추론 출력은 부분값이며 totalTokens에 다시 더하지 않습니다. cacheWriteInputTokens는 제공되는 경우만 기록합니다.\n- usageStatus: reported_cumulative_delta=확인된 누적 차이, unknown_baseline=재접속 등으로 기준값 불명, counter_discontinuity=카운터 감소, missing_usage_event=이벤트 미제공.\n- actualModel: 모델 변경 이벤트 등으로 확인된 경우만 기록. null은 요청 모델과 다른 모델을 사용했다는 뜻이 아닙니다.\n- queueMs: 전송 전 대기. firstOutputMs: 전송부터 첫 agentMessage 출력 이벤트까지. durationMs: 전송부터 완료 관측까지. 네트워크를 포함하며 순수 추론 시간이 아닙니다.\n- deliveryMs: 발화 저장부터 모든 수신자 처리 완료까지의 벽시계 시간. 모아 전달에서는 다음 차례·일시정지를 포함할 수 있습니다. 미완료는 null입니다.\n- elapsedMs: 묶음 시작 이후 실제 경과 시간. activeMs: 실행 작업 구간의 단조 시계 누적. pausedMs: 일시정지 구간. durationSumMs는 병렬 호출 시간을 합산하므로 경과 시간과 다릅니다.\n- tokensPerSpeech: 모든 호출 종류의 확인된 토큰 합계 / 공개 발화 수. missingUsage가 있으면 부분 합계입니다.\n- medianMs / p95Ms: 성공한 호출의 durationMs 분포, nearest-rank 방식. 실패율 분모는 모든 호출 시도입니다.\n- issueRate: 기각되지 않은 issue가 하나 이상 있는 발화 수 / 평가된 발화 수. AI의 의심 결과이며 사람의 확정률과 다릅니다.\n- quality.repetition.rate: 최근 repetitionWindow 공개 발화 안의 같은 화자 대사와 비교 가능한 발화 중 문자 3-gram Dice 유사도 threshold 이상인 비율. NFKC·소문자·문장부호 제거 후 최소 minChars 이상만 비교. 짧은 응답·행동·사건 제외, 분모 0은 null. 의미 반복률과 다릅니다.\n- quality.semanticRepetition.rate: 기각되지 않은 AI repetition 지적이 있는 발화 수 / 평가 완료 발화 수.\n- quality.progression: 사전 정의한 환경 상태에 의한 목표 달성. 미설정은 null. goals의 achieved는 현재 충족, firstAchievedAtSpeech는 최초 충족 순번(초기 충족=0). stalledSpeechCount는 마지막 확정 상태 변화 이후 공개 발화 수이며 자동 실패 판정이 아닙니다.\n- resolution: 엔진이 확정한 actionId, 원본 발화 ID, actorId, before/after 상태. NPC 서술이나 수동 상황 투입은 구조화 상태를 변경하지 않습니다.\n- 환경 결과 사건은 공개 발화 수에서 제외되며 per_utterance에서 모든 NPC 수신 호출을 발생시킵니다. 이 비용은 receive에 포함됩니다.\n- contextTruncated: 평가 맥락의 앞부분이 길이 한도로 제외됨. 원본 대화는 삭제되지 않습니다.\n- adapter=mock: 동작 검사용 모의 데이터. 실제 모델 평가·사용량과 혼합하지 마세요.\n\n예: pandas.read_csv('invocations.csv')로 읽고 kind, model, effort, deliveryMode, memoryMode별로 묶어 분석합니다. 토큰 합계와 함께 missingUsage 및 실패 수를 확인하세요.\n`,
  };
}

// Small ZIP writer using uncompressed entries; no external archiver or shell needed.
export function zipFiles(files: Record<string, string>): Buffer {
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) { c ^= x; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (c ^ 0xffffffff) >>> 0; };
  const parts: Buffer[] = [], directory: Buffer[] = []; let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const filename = Buffer.from(name), data = Buffer.from(content), checksum = crc(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt32LE(checksum, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt32LE(checksum, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    parts.push(local, filename, data); directory.push(central, filename); offset += local.length + filename.length + data.length;
  }
  const dir = Buffer.concat(directory), end = Buffer.alloc(22), count = Object.keys(files).length;
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}
