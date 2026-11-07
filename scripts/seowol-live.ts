import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { OpenAIAdapter } from '../src/adapters/openai.js';
import { Engine } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
import { exportFiles } from '../src/core/export.js';
import { environmentMode, experimentSchema } from '../src/shared/schema.js';
import { PROMPT_VERSION } from '../src/core/prompts.js';
import { WORLD_PROMPT_VERSION } from '../src/core/world-policies.js';
import { WORLD_PROMPT_VERSIONS, type WorldPromptVersion } from '../src/shared/world-policy.js';
import { CURRENT_DIALOGUE_PROMPT, DIALOGUE_PROMPT_VERSIONS, type DialoguePromptVersion } from '../src/shared/dialogue-policy.js';
import { DIRECTOR_CONTEXT } from '../src/core/director.js';
import { ReviewBudget, reviewBudgetFile } from './review-budget.js';

// Explicit paid experiment. Each run has fresh NPC sessions and an isolated DB.
// Runs in an isolated database with the authored scene and delivery settings.
const { values } = parseArgs({ options: {
  live: { type: 'boolean', default: false }, spec: { type: 'string' },
  label: { type: 'string', default: 'review' }, model: { type: 'string' }, variant: { type: 'string' },
  policy: { type: 'string' }, 'world-policy': { type: 'string' },
  turns: { type: 'string', default: '12' }, repetitions: { type: 'string', default: '1' },
  'max-calls': { type: 'string', default: '80' }, 'max-usd': { type: 'string', default: '1' },
} });
if (!values.spec) throw new Error('--spec is required. Add --live only to make paid API calls.');
const turns = Number(values.turns), repetitions = Number(values.repetitions);
const maxCalls = Number(values['max-calls']), maxUsd = Number(values['max-usd']);
const spec = experimentSchema.parse(JSON.parse(await readFile(resolve(values.spec), 'utf8')));
const variant = values.variant ? spec.variants.find(v => v.id === values.variant) : spec.variants[0];
if (!variant) throw Error('Unknown variant.');
const dialoguePromptVersion = (values.policy ?? variant.dialoguePromptVersion ?? CURRENT_DIALOGUE_PROMPT) as DialoguePromptVersion;
const worldPromptVersion = (values['world-policy'] ?? variant.worldPromptVersion ?? WORLD_PROMPT_VERSION) as WorldPromptVersion;
if (!Number.isSafeInteger(turns) || turns < 3 || turns > 60 || !Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 3 ||
    !Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 600 || !Number.isFinite(maxUsd) || maxUsd <= 0 || maxUsd > 10 ||
    !DIALOGUE_PROMPT_VERSIONS.includes(dialoguePromptVersion) || !WORLD_PROMPT_VERSIONS.includes(worldPromptVersion)) {
  throw new Error('Invalid live experiment limits.');
}
const model = values.model ?? variant.model ?? spec.scenario.defaults.model;
spec.name += ` [${values.label}]`;
spec.maxUtterances = turns; spec.repetitions = repetitions;
spec.concurrentRuns = 1; spec.maxConcurrentCalls = 1; spec.timeoutMs = 120_000;
spec.evaluation.enabled = false;
spec.variants = [{ ...variant, dialoguePromptVersion, worldPromptVersion, ...(values.model && { model }) }];
if (values.model) for (const c of spec.scenario.characters) delete c.model;
const plan = { promptVersion: PROMPT_VERSION, worldPromptVersion, dialoguePromptVersion, directorVersion: DIRECTOR_CONTEXT.version, scenario: spec.scenario.name, model,
  environmentMode: environmentMode(spec, variant), variant: variant.id, director: spec.director, worldEngine: spec.worldEngine,
  turns, repetitions, maxCalls, maxUsd,
  costLimit: 'Reserve each request before dispatch, then settle reported usage at catalogue rates.' };
experimentSchema.parse(spec);
if (!values.live) { console.log(JSON.stringify({ live: false, ...plan }, null, 2)); }
else {
  const label = values.label!.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 50);
  const root = resolve('.cache', 'seowol-live', `${new Date().toISOString().replace(/[:.]/g, '-')}-${label}`);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'plan.json'), JSON.stringify(plan, null, 2));
  await writeFile(join(root, 'config.json'), JSON.stringify(spec, null, 2));
  for (const file of ['prompts.ts', 'dialogue-policies.ts', 'world.ts', 'world-policies.ts', 'director.ts']) {
    await writeFile(join(root, file + '.snapshot.txt'), await readFile(resolve('src/core', file), 'utf8'));
  }
  const models = [model, spec.director.model, spec.worldEngine?.model, spec.eventGenerator?.model, ...spec.scenario.characters.map(c => c.model)].filter((s): s is string => !!s);
  using budget = new ReviewBudget(reviewBudgetFile(root), maxUsd, models);
  const adapter = new OpenAIAdapter(join(root, 'runtime'), { maxOutputTokens: 4096, fetch: budget.fetch });
  const store = new Store(join(root, 'npc-lab.sqlite'));
  const engine = new Engine(store, adapter, root);
  const turn = adapter.turn.bind(adapter); let requests = 0;
  adapter.turn = async (...args) => {
    if (requests >= maxCalls) throw new Error('Live experiment request limit reached.');
    requests++;
    const result = await turn(...args);
    budget.settle(args[0].clientMessageId,result);
    if (result.status === 'completed') {
      const input = JSON.parse(args[0].input);
      if (input.task === 'speak') console.log(JSON.stringify({ request: requests, task: input.task, ...JSON.parse(result.output) }));
    }
    return result;
  };
  console.log(JSON.stringify({ root, ...plan }));
  try {
    const { runs } = await engine.create(spec); await engine.idle();
    const reports = [];
    for (const run of runs) {
      const detail = engine.detail(run.id), files = exportFiles(detail, store.events(run.id));
      const directory = join(root, `run-${run.repetition}`); await mkdir(directory, { recursive: true });
      for (const [name, text] of Object.entries(files)) await writeFile(join(directory, name), text);
      reports.push({ id: run.id, status: detail.run.status, error: detail.run.error, summary: detail.summary });
    }
    await writeFile(join(root, 'result.json'), JSON.stringify({ ...plan, requests, runs: reports }, null, 2));
    console.log(JSON.stringify({ root, requests, runs: reports.map(r => ({ id: r.id, status: r.status, error: r.error,
      speeches: r.summary.speechCount, cost: r.summary.cost, tokens: r.summary.tokens })) }, null, 2));
    if (reports.some(r => r.status !== 'completed')) process.exitCode = 1;
  } catch (error) {
    // Model discovery/connection can fail before a run exists. Preserve that
    // distinction rather than leaving an apparently unfinished experiment.
    const message = error instanceof Error ? error.message : String(error);
    await writeFile(join(root, 'result.json'), JSON.stringify({ ...plan, requests, status: 'setup_failed', error: message }, null, 2));
    console.error(JSON.stringify({ root, requests, status: 'setup_failed', error: message }));
    process.exitCode = 1;
  } finally { await engine.close(); store.close(); }
}
