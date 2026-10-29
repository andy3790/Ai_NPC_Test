import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { Store } from '../src/core/store.js';
import { Engine } from '../src/core/engine.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { exampleSpec } from '../src/shared/example.js';
import { exportFiles, zipFiles } from '../src/core/export.js';
const root = resolve('reports', `progression-${Date.now()}`); await mkdir(root, { recursive: true });
const adapter = new CodexAdapter(join(root, 'runtime')), store = new Store(join(root, 'npc-lab.sqlite')), engine = new Engine(store, adapter, root);
const timer = setInterval(() => console.log(JSON.stringify(store.list('runs').map(r => { const d = engine.detail(r.id); return { mode: r.variant.deliveryMode, status: r.status, speech: d.summary.speechCount, goals: d.summary.quality.progression.achievedGoals, error: r.error }; }))), 20_000);
console.log(`REPORT_DIRECTORY ${root}`);
try {
  const models = await adapter.models(), model = models.find(m => m.isDefault) ?? models[0];
  const spec = exampleSpec(model.id, model.efforts.includes('low') ? 'low' : model.defaultEffort);
  const { runs, experimentId } = await engine.create(spec);
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ experimentId, spec, runs: runs.map(r => ({ id: r.id, mode: r.variant.deliveryMode })) }, null, 2));
  await engine.idle(); const reports = [];
  for (const run of runs) {
    const d = engine.detail(run.id), folder = join(root, run.variant.deliveryMode); await mkdir(folder, { recursive: true });
    const files = exportFiles(d, store.events(run.id)); for (const [name, value] of Object.entries(files)) await writeFile(join(folder, name), value);
    await writeFile(join(folder, 'detail.json'), JSON.stringify(d, null, 2)); await writeFile(join(root, `${run.variant.deliveryMode}.zip`), zipFiles(files));
    reports.push({ mode: run.variant.deliveryMode, runId: run.id, status: d.run.status, completionReason: d.run.completionReason, summary: d.summary, findings: d.findings });
  }
  await writeFile(join(root, 'report.json'), JSON.stringify(reports, null, 2));
  for (const report of reports) { assert.equal(report.status, 'completed'); assert.equal(report.summary.quality.progression.allGoalsAchieved, true); assert.equal(report.summary.missingUsage, 0); assert.equal(report.summary.failed, 0); }
  console.log(`PROGRESSION_LIVE_OK ${root}`);
} finally { clearInterval(timer); await engine.close(); store.close(); }
