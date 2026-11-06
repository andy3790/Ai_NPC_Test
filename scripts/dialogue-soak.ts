import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createAdapter } from '../src/adapters/factory.js';
import { Engine } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
import { exportFiles } from '../src/core/export.js';
import { prepareConversations } from './lib/dialogue-soak.js';
import { sha256 } from './lib/dialogue-eval.js';
import { worldPolicies, WORLD_PROMPT_VERSION } from '../src/core/world-policies.js';
import { outputSchemas } from '../src/shared/schema.js';
import { CURRENT_DIALOGUE_PROMPT, DIALOGUE_PROMPT_VERSIONS, type DialoguePromptVersion } from '../src/shared/dialogue-policy.js';
import { dialoguePolicies } from '../src/core/dialogue-policies.js';
import { baseInstructions, PROMPT_VERSION } from '../src/core/prompts.js';

const { values } = parseArgs({ options: {
  live: { type: 'boolean', default: false }, adapter: { type: 'string', default: 'openai' },
  model: { type: 'string', default: 'gpt-6.1-sol' }, effort: { type: 'string', default: 'low' },
  specs: { type: 'string', default: 'evals/dialogue/conversations.json' },
  baseline: { type: 'string', default: 'npc-dialogue/1' }, candidate: { type: 'string', default: CURRENT_DIALOGUE_PROMPT },
  turns: { type: 'string', default: '18' }, repetitions: { type: 'string', default: '1' },
  'world-model': { type: 'string' }, 'world-effort': { type: 'string', default: 'medium' },
  'max-calls': { type: 'string', default: '200' },
  'max-usd': { type: 'string', default: '3' },
} });
const maxUsd = Number(values['max-usd']);
const maxCalls = Number(values['max-calls']), turns = Number(values.turns), repetitions = Number(values.repetitions);
const baseline = values.baseline as DialoguePromptVersion, candidate = values.candidate as DialoguePromptVersion;
if (!['openai', 'codex'].includes(values.adapter!) || !Number.isFinite(maxUsd) || maxUsd <= 0 || maxUsd > 10 ||
    !Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 500 || !Number.isSafeInteger(turns) || turns < 3 || turns > 60 ||
    !Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 3 ||
    !DIALOGUE_PROMPT_VERSIONS.includes(baseline) || !DIALOGUE_PROMPT_VERSIONS.includes(candidate) || baseline === candidate) throw new Error('Invalid limits/adapter/policies.');
const raw = await readFile(resolve(values.specs!), 'utf8');
const fixtures = JSON.parse(raw) as unknown[];
if (!Array.isArray(fixtures) || !fixtures.length) throw new Error('At least one conversation fixture is required.');
const { specs, expectedCalls } = prepareConversations(fixtures, { model: values.model!, effort: values.effort!, baseline, candidate, turns, repetitions, worldModel: values['world-model'], worldEffort: values['world-effort']! });
if (expectedCalls > maxCalls) throw new Error(`Plan needs up to ${expectedCalls} calls; limit is ${maxCalls}.`);
const plan = { adapter: values.adapter, model: values.model, effort: values.effort, maxCalls, expectedCalls, maxUsd, turns, repetitions,
  promptVersion: PROMPT_VERSION, worldPromptVersion: WORLD_PROMPT_VERSION, fixturesSha256: sha256(raw), baseline, candidate, costLimit: 'API catalogue equivalent, not subscription billing; last response may overshoot. No retry.' };
if (!values.live) console.log(JSON.stringify({ live: false, ...plan }, null, 2));
else {
  const root = resolve('.cache/dialogue-soak', new Date().toISOString().replace(/[:.]/g, '-'));
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'configs.json'), JSON.stringify(specs, null, 2));
  await writeFile(join(root, 'policies.json'), JSON.stringify({ baseInstructions, policies: dialoguePolicies, worldPolicies, outputSchemas }, null, 2));
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
        const directory = join(root, `${spec.scenario.id}-${run.variant.dialoguePromptVersion!.replace('/', '-')}-${run.repetition}`);
        await mkdir(directory, { recursive: true });
        for (const [name, content] of Object.entries(exportFiles(detail, store.events(run.id)))) await writeFile(join(directory, name), content);
        reports.push({ scene: spec.scenario.id, policy: run.variant.dialoguePromptVersion, repetition: run.repetition, status: detail.run.status,
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
