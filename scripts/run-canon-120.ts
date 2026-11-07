import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import type { ExperimentSpec } from '../src/shared/schema.js';
import type { RunDetail } from '../src/shared/types.js';

const base = process.env.NPC_LAB_URL ?? 'http://127.0.0.1:4317/api';
const source = resolve('assets/npc-canon/experiments/orison-ensemble.json');
const { values, positionals } = parseArgs({ allowPositionals: true, options: { model: { type: 'string', default: 'gpt-6-luna' }, effort: { type: 'string', default: 'medium' }, adapter: { type: 'string', default: 'codex' } } });
if (positionals.length !== 1) throw new Error('사용법: node --import tsx scripts/run-canon-120.ts reports/<실험-폴더> [--model gpt-6-luna] [--effort low] [--adapter openai]');
const config = { model: values.model, effort: values.effort };
const modelTag = ({ 'gpt-6.1-terra': 'terra', 'gpt-6-luna': 'luna' } as Record<string, string>)[config.model] ?? config.model.replace(/[^a-zA-Z0-9_-]/g, '-');
const modelLabel = ({ 'gpt-6.1-terra': 'Terra', 'gpt-6-luna': 'Luna' } as Record<string, string>)[config.model] ?? config.model;
const directory = resolve(positionals[0]);
await mkdir(directory, { recursive: true });
async function api(path: string, body?: unknown) {
  const response = await fetch(base + path, { ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
const health = await api('/health');
if (health.adapter !== values.adapter) throw new Error(`요청한 실행 경로 ${values.adapter}와 서버 ${health.adapter}가 다릅니다.`);
let manifest;
if (existsSync(join(directory, 'manifest.json'))) {
  // Restarting the monitor must never start another paid experiment.
  manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  if (manifest.spec.scenario.defaults.model !== config.model || manifest.spec.scenario.defaults.effort !== config.effort || (manifest.adapter && manifest.adapter !== values.adapter)) throw new Error('기존 manifest의 조건이 다릅니다. 해당 실험 조건으로 조회하거나 새 폴더를 지정하세요.');
} else {
  const original = await readFile(source, 'utf8');
  const spec: ExperimentSpec = JSON.parse(original);
  spec.name = `궤도정거장 헤스티아 · ${health.adapter} · ${modelLabel} ${config.effort} · 120발화`;
  spec.scenario.defaults = config;
  for (const c of spec.scenario.characters) { delete c.model; delete c.effort; }
  spec.variants = [{ id: `${modelTag}-${config.effort}-batch`, label: `${modelLabel} ${config.effort} · 모아 전달 · 초기 설정 유지`, ...config, memoryMode: 'initial_only', deliveryMode: 'batched_on_turn', turnPolicy: 'round_robin' }];
  spec.maxUtterances = 120; spec.repetitions = 1; spec.concurrentRuns = 1; spec.maxConcurrentCalls = 1;
  spec.evaluation = { ...spec.evaluation, ...config, enabled: true, interval: 10 };
  spec.director = config;
  if (spec.scenario.environment) spec.scenario.environment.stopOnGoals = false;
  const validated = await api('/validate', spec);
  await writeFile(join(directory, 'source-experiment.json'), original);
  await writeFile(join(directory, 'prepared-config.json'), JSON.stringify(validated.spec, null, 2));
  // Write before POST so an interrupted creation is never blindly retried.
  if (existsSync(join(directory, 'creation-attempt.json'))) throw new Error('이전 생성 시도가 있습니다. 서버 묶음을 대조한 뒤 manifest를 복구하세요. 자동 중복 생성하지 않습니다.');
  await writeFile(join(directory, 'creation-attempt.json'), JSON.stringify({ requestedAt: new Date().toISOString(), name: spec.name }));
  const created = await api('/experiments', { spec: validated.spec, start: true });
  manifest = { startedAt: new Date().toISOString(), adapter: health.adapter, source: 'assets/npc-canon/experiments/orison-ensemble.json', sourceSha256: createHash('sha256').update(original).digest('hex'), experimentId: created.experimentId,
    runs: created.runs.map((r: any) => ({ id: r.id, mode: r.variant.deliveryMode })), spec: validated.spec };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
}
console.log(JSON.stringify({ directory, experimentId: manifest.experimentId, runs: manifest.runs }));
for (;;) {
  const detail = await api(`/runs/${manifest.runs[0].id}`) as RunDetail;
  const status = { at: new Date().toISOString(), runId: detail.run.id, status: detail.run.status, speeches: detail.summary.speechCount,
    evaluated: detail.summary.evaluatedUtterances, calls: detail.summary.calls, tokens: detail.summary.tokens.totalTokens,
    failed: detail.summary.failed, missingUsage: detail.summary.missingUsage, findings: detail.findings.length,
    repetitions: detail.summary.quality?.repetition, elapsedSeconds: Math.round(detail.summary.elapsedMs / 1000), error: detail.run.error };
  console.log(JSON.stringify({ ...status, repetitions: status.repetitions?.rate }));
  await writeFile(join(directory, 'latest-status.json'), JSON.stringify(status, null, 2));
  if (['completed', 'paused', 'stopped'].includes(detail.run.status)) {
    await writeFile(join(directory, 'detail.json'), JSON.stringify(detail, null, 2));
    const files = await api(`/runs/${detail.run.id}/export`) as Record<string, string>;
    for (const [name, value] of Object.entries(files)) await writeFile(join(directory, name), value);
    const zip = await fetch(`${base}/runs/${detail.run.id}/export.zip`);
    if (!zip.ok) throw new Error(await zip.text());
    await writeFile(join(directory, `${health.adapter === 'codex' ? '' : health.adapter + '-'}orison-${modelTag}-${config.effort}-120.zip`), Buffer.from(await zip.arrayBuffer()));
    console.log(`EXPORTED ${directory}`);
    if (detail.run.status !== 'completed') process.exitCode = 2;
    break;
  }
  await new Promise(r => setTimeout(r, 30_000));
}
