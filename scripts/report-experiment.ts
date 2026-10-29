import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { RunDetail, InvocationMetrics } from '../src/shared/types.js';
if (!process.argv[2]) throw new Error('사용법: node --import tsx scripts/report-experiment.ts reports/<비교-실험-폴더>');
const directory = resolve(process.argv[2]);
const base = process.env.NPC_LAB_URL ?? 'http://127.0.0.1:4317/api';
const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
const stats = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b);
  return { count: values.length, mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
    median: values.length ? sorted[Math.ceil(values.length * .5) - 1] : null,
    p95: values.length ? sorted[Math.ceil(values.length * .95) - 1] : null };
};
const measured = (calls: InvocationMetrics[], field: 'durationMs' | 'firstOutputMs' | 'queueMs') => stats(calls.filter(c => c.status === 'completed' && c[field] !== null).map(c => c[field]!));
const reports = [];
for (const entry of manifest.runs) {
  const response = await fetch(`${base}/runs/${entry.id}`);
  if (!response.ok) throw new Error(await response.text());
  const detail = await response.json() as RunDetail;
  if (detail.run.status !== 'completed') throw new Error(`${entry.mode}: ${detail.run.status} (${detail.run.error ?? ''})`);
  const folder = join(directory, entry.mode); await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'detail.json'), JSON.stringify(detail, null, 2));
  const exported = await fetch(`${base}/runs/${entry.id}/export`).then(r => r.json()) as Record<string, string>;
  for (const [name, content] of Object.entries(exported)) await writeFile(join(folder, name), content);
  const zip = await fetch(`${base}/runs/${entry.id}/export.zip`).then(r => r.arrayBuffer());
  await writeFile(join(directory, `${entry.mode}.zip`), Buffer.from(zip));
  const speech = detail.invocations.filter(c => c.kind === 'speech');
  const cycles = detail.utterances.filter(u => u.kind === 'speech').flatMap(u => {
    const call = speech.find(c => c.id === u.invocationId);
    if (!call?.durationMs) return [];
    if (entry.mode === 'per_utterance' && u.deliveryMs === null) return [];
    return [call.durationMs + (entry.mode === 'per_utterance' ? u.deliveryMs! : 0)];
  });
  const report = {
    mode: entry.mode, runId: entry.id, snapshotHash: detail.run.snapshotHash,
    model: detail.run.spec.scenario.defaults.model, effort: detail.run.spec.scenario.defaults.effort,
    memoryMode: detail.run.variant.memoryMode, turnPolicy: detail.run.variant.turnPolicy,
    summary: detail.summary, publicSpeechLatencyMs: measured(speech, 'durationMs'),
    publicFirstOutputMs: measured(speech, 'firstOutputMs'), publicQueueMs: measured(speech, 'queueMs'),
    publicSpeechAndDeliveryCycleMs: stats(cycles),
    receiveLatencyMs: measured(detail.invocations.filter(c => c.kind === 'receive'), 'durationMs'),
    perCharacter: detail.run.spec.scenario.characters.map(c => ({ id: c.id, name: c.name,
      speechCount: detail.utterances.filter(u => u.speakerId === c.id).length,
      latencyMs: measured(speech.filter(x => x.characterId === c.id), 'durationMs'),
      findings: detail.findings.filter(f => detail.utterances.some(u => u.id === f.utteranceId && u.speakerId === c.id)),
    })),
    evaluations: detail.evaluations, findings: detail.findings,
    compactions: detail.invocations.reduce((sum, c) => sum + Number(c.metadata.compactions ?? 0), 0),
    reroutes: detail.invocations.filter(c => c.actualModel).map(c => ({ id: c.id, from: c.model, to: c.actualModel })),
  };
  reports.push(report);
  await writeFile(join(folder, 'review-transcript.txt'), detail.utterances.map(u => `#${u.speechIndex ?? 'event'} ${u.speakerName}\n${u.speech}\n[행동] ${u.action}\n`).join('\n'));
}
await writeFile(join(directory, 'summary.json'), JSON.stringify({ generatedAt: new Date().toISOString(), experimentId: manifest.experimentId, reports }, null, 2));
console.log(JSON.stringify(reports.map(r => ({ mode: r.mode, summary: r.summary, speechLatency: r.publicSpeechLatencyMs, cycleLatency: r.publicSpeechAndDeliveryCycleMs, compactions: r.compactions, findings: r.findings })), null, 2));
