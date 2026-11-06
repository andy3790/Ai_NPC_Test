import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createAdapter } from '../src/adapters/factory.js';
import { Engine } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
import { exportFiles } from '../src/core/export.js';
import { experimentSchema } from '../src/shared/schema.js';
import { CURRENT_DIALOGUE_PROMPT } from '../src/shared/dialogue-policy.js';
import { dialoguePolicies } from '../src/core/dialogue-policies.js';
import { baseInstructions, PROMPT_VERSION } from '../src/core/prompts.js';

const { values } = parseArgs({ options: {
  live: { type: 'boolean', default: false }, adapter: { type: 'string', default: 'openai' },
  model: { type: 'string', default: 'gpt-6.1-sol' }, effort: { type: 'string', default: 'low' },
  'max-usd': { type: 'string', default: '3' },
} });
const maxUsd = Number(values['max-usd']);
if (!['openai', 'codex'].includes(values.adapter!) || !Number.isFinite(maxUsd) || maxUsd <= 0 || maxUsd > 10) throw new Error('Invalid limits/adapter.');
const raw = await readFile(resolve('evals/dialogue/conversations.json'), 'utf8');
const fixtures = JSON.parse(raw) as unknown[];
const specs = fixtures.map((fixture, i) => {
  const spec = experimentSchema.parse(fixture);
  spec.scenario.defaults = { model: values.model!, effort: values.effort! };
  for (const c of spec.scenario.characters) { delete c.model; delete c.effort; }
  spec.evaluation.enabled = false; spec.concurrentRuns = 1; spec.maxConcurrentCalls = 1; spec.timeoutMs = 90_000;
  spec.repetitions = 1; spec.maxUtterances = 18;
  const versions = i % 2 ? [CURRENT_DIALOGUE_PROMPT, 'npc-dialogue/1'] as const : ['npc-dialogue/1', CURRENT_DIALOGUE_PROMPT] as const;
  spec.variants = versions.map((version, index) => ({ id: `condition-${index}`, label: version, dialoguePromptVersion: version,
    environmentMode: 'off', stopOnSilence: true, deliveryMode: 'batched_on_turn', memoryMode: 'initial_only', turnPolicy: 'round_robin', eventGeneration: false }));
  spec.scheduledEvents = [];
  return experimentSchema.parse(spec);
});
const maxCalls = specs.reduce((n, s) => n + s.variants.length * s.maxUtterances, 0);
if (maxCalls > 100) throw new Error('Conversation fixture exceeds the 100-call bound.');
const plan = { adapter: values.adapter, model: values.model, effort: values.effort, maxCalls, maxUsd, promptVersion: PROMPT_VERSION,
  candidate: CURRENT_DIALOGUE_PROMPT, costLimit: 'API catalogue equivalent, not subscription billing; last response may overshoot. No retry.' };
if (!values.live) console.log(JSON.stringify({ live: false, ...plan }, null, 2));
else {
  const root = resolve('.cache/dialogue-soak', new Date().toISOString().replace(/[:.]/g, '-'));
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'configs.json'), JSON.stringify(specs, null, 2));
  await writeFile(join(root, 'policies.json'), JSON.stringify({ baseInstructions, policies: dialoguePolicies }, null, 2));
  const adapter = createAdapter(values.adapter!, join(root, 'runtime'));
  const store = new Store(join(root, 'npc-lab.sqlite'));
  const engine = new Engine(store, adapter, root);
  const turn = adapter.turn.bind(adapter); let calls = 0;
  const reports: unknown[] = [];
  adapter.turn = async (...args) => {
    const summaries = engine.list().map(r => r.summary);
    if (calls >= maxCalls || summaries.some(s => s.cost.unpricedCalls) || summaries.reduce((n, s) => n + (s.cost.usd ?? 0), 0) >= maxUsd) {
      throw new Error('Conversation budget or missing-usage stop.');
    }
    calls++;
    const result = await turn(...args);
    console.log(JSON.stringify({ calls, status: result.status }));
    return result;
  };
  console.log(JSON.stringify({ root, ...plan }));
  let error: string | null = null;
  try {
    for (const spec of specs) {
      const { runs } = await engine.create(spec); await engine.idle();
      for (const run of runs) {
        const detail = engine.detail(run.id);
        const directory = join(root, `${spec.scenario.id}-${run.variant.dialoguePromptVersion!.replace('/', '-')}`);
        await mkdir(directory, { recursive: true });
        for (const [name, content] of Object.entries(exportFiles(detail, store.events(run.id)))) await writeFile(join(directory, name), content);
        reports.push({ scene: spec.scenario.id, policy: run.variant.dialoguePromptVersion, status: detail.run.status,
          completionReason: detail.run.completionReason, error: detail.run.error, summary: detail.summary });
      }
      if (runs.some(r => engine.run(r.id).status !== 'completed')) throw new Error('Conversation did not complete; stopped without retry.');
    }
  } catch (e) { error = e instanceof Error ? e.message : String(e); process.exitCode = 1; }
  finally {
    const estimatedUsd = engine.list().reduce((n, r) => n + (r.summary.cost.usd ?? 0), 0);
    await writeFile(join(root, 'result.json'), JSON.stringify({ ...plan, calls, estimatedUsd, error, reports }, null, 2));
    console.log(JSON.stringify({ root, calls, estimatedUsd, error }));
    await engine.close(); store.close();
  }
}
