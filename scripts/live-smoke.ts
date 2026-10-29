import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { CodexAdapter } from '../src/adapters/codex.js';
import { Store } from '../src/core/store.js';
import { Engine } from '../src/core/engine.js';
import { exampleSpec } from '../src/shared/example.js';
import { exportFiles, zipFiles } from '../src/core/export.js';
const root = resolve('.cache', `live-smoke-${Date.now()}`); await mkdir(root, { recursive: true });
const adapter = new CodexAdapter(join(root, 'runtime')); const store = new Store(join(root, 'npc-lab.sqlite')); const engine = new Engine(store, adapter, root);
const timer = setInterval(() => { console.log(JSON.stringify(store.list('runs').map(r => ({ id: r.id, delivery: r.variant.deliveryMode, status: r.status, speeches: store.list('utterances', r.id).filter(u => u.kind === 'speech').length, calls: store.list('invocations', r.id).length, error: r.error })))); }, 15_000);
try {
  const models = await adapter.models(); const model = models.find(m => m.id === process.env.NPC_SMOKE_MODEL) ?? models.find(m => m.isDefault) ?? models[0];
  const spec = exampleSpec(model.id, model.efforts.includes('low') ? 'low' : model.defaultEffort);
  delete spec.scenario.environment; // This smoke checks the original 6 + 6 call contract.
  spec.name = '실제 Codex 연결 검증'; spec.scenario.characters = spec.scenario.characters.slice(0, 2); spec.maxUtterances = 6; spec.evaluation.interval = 6;
  const { runs } = await engine.create(spec); await engine.idle();
  const report = [];
  for (const run of runs) {
    const d = engine.detail(run.id); console.log(JSON.stringify({ run: run.id, status: d.run.status, error: d.run.error, summary: d.summary }));
    await writeFile(join(root, `${run.variant.id}.zip`), zipFiles(exportFiles(d, store.events(run.id))));
    assert.equal(d.run.status, 'completed', d.run.error ?? '미완료'); assert.equal(d.summary.speechCount, 6);
    assert.equal(d.summary.byKind.receive.calls, run.variant.deliveryMode === 'per_utterance' ? 6 : 0);
    assert.equal(d.summary.evaluationFailures, 0); assert.equal(d.summary.missingUsage, 0);
    const first = d.invocations.find(c => c.kind === 'speech')!;
    assert.equal((await adapter.reconcile(first.threadId, first.turnId, first.id))?.output, first.output, '기록된 turn 출력 복원');
    assert.equal((await adapter.reconcile(first.threadId, null, first.id))?.turnId, first.turnId, 'client message ID로 turn 복원');
    assert.ok(!store.events(run.id).some(e => e.method === 'item/started' && ['commandExecution', 'mcpToolCall', 'webSearch', 'collabToolCall', 'fileChange'].includes((e.params as any).item?.type)), '도구 호출이 없어야 합니다.');
    report.push({ runId: run.id, mode: run.variant.deliveryMode, summary: d.summary });
  }
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2)); console.log(`LIVE_SMOKE_OK ${root}`);
} finally { clearInterval(timer); await engine.close(); store.close(); }
