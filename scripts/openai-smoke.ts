import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { OpenAIAdapter } from '../src/adapters/openai.js';
import { Engine } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
import { exampleSpec } from '../src/shared/example.js';
import { exportFiles, zipFiles } from '../src/core/export.js';

// Explicit opt-in command; never run by verify or CI. Two modes, 2 NPCs,
// 2 speeches each and one evaluation per run: 8 model requests in total.
const root = resolve('.cache', `openai-smoke-${Date.now()}`);
const adapter = new OpenAIAdapter(join(root, 'runtime'));
await mkdir(root, { recursive: true });
const store = new Store(join(root, 'npc-lab.sqlite')), engine = new Engine(store, adapter, root);
try {
  const models = await adapter.models();
  const model = process.env.NPC_OPENAI_SMOKE_MODEL ? models.find(m => m.id === process.env.NPC_OPENAI_SMOKE_MODEL) : models[0];
  if (!model) throw new Error('지정한 smoke 모델이 API 지원 목록에 없습니다.');
  const spec = exampleSpec(model.id, model.defaultEffort);
  delete spec.scenario.environment; spec.scenario.characters = spec.scenario.characters.slice(0, 2);
  spec.maxUtterances = 2; spec.evaluation.interval = 2; spec.concurrentRuns = 1; spec.maxConcurrentCalls = 1;
  const { runs } = await engine.create(spec); await engine.idle();
  for (const run of runs) {
    const detail = engine.detail(run.id), files = exportFiles(detail, store.events(run.id));
    const directory = join(root, run.variant.deliveryMode); await mkdir(directory, { recursive: true });
    for (const [name, content] of Object.entries(files)) await writeFile(join(directory, name), content);
    await writeFile(join(directory, 'export.zip'), zipFiles(files));
    assert.equal(detail.run.status, 'completed', detail.run.error ?? undefined);
    assert.equal(detail.summary.missingUsage, 0);
    assert.equal(detail.invocations.filter(c => c.kind === 'receive').length, run.variant.deliveryMode === 'per_utterance' ? 2 : 0);
  }
  console.log(`OPENAI_SMOKE_OK ${root}`);
} finally { await engine.close(); store.close(); }
