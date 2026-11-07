import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { OpenAIAdapter } from '../src/adapters/openai.js';
import { Engine } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
import { experimentSchema } from '../src/shared/schema.js';
import { CHARACTER_PERFORMANCE } from '../src/shared/character-performance.js';
import { exampleSpec } from '../src/shared/example.js';
import { interruptTest, stopTestRuns } from './lib/test-sessions.js';

const { values } = parseArgs({ options: { live: { type: 'boolean' }, split: { type: 'string', default: 'development' },
  repetitions: { type: 'string', default: '1' }, turns: { type: 'string', default: '6' },
  candidate: { type: 'string', default: CHARACTER_PERFORMANCE } } });
const repetitions = Number(values.repetitions);
const turns = Number(values.turns);
if (!['development', 'holdout', 'rich', 'migration', 'blank'].includes(values.split!) || ![1, 2, 3].includes(repetitions) ||
    ![6, 12].includes(turns) || !['character-performance/1', CHARACTER_PERFORMANCE].includes(values.candidate!)) throw Error('Invalid experiment options');
const fixturesFile = resolve('evals/dialogue/character-performance.json');
const fixtures = JSON.parse(readFileSync(fixturesFile, 'utf8')) as {
  id: string; split: string; world: string; situation: string; characters: object[]; events: { afterUtterance: number; text: string }[]; review: string;
}[];
const harbor = (revision: 'harbor-profile/4' | 'harbor-profile/5') => exampleSpec('gpt-6.1-sol', 'low', revision).scenario.characters.filter(c => c.id !== 'doha');
let cases = fixtures.filter(c => c.split === values.split);
if (values.split === 'rich' || values.split === 'migration') cases = [{ ...fixtures[1], id: 'harbor-' + values.split, characters: harbor('harbor-profile/4') }];
if (values.split === 'blank') cases = [{ ...fixtures[0], id: 'names-only', characters: [{ id: 'one', name: '한결' }, { id: 'two', name: '은서' }] }];
const config = { model: 'gpt-6.1-sol', effort: 'low' };
const maxCalls = cases.length * repetitions * 2 * turns;
const plan = { split: values.split, repetitions, turns, ...config, maxCalls, maxEstimatedUsd: 1, characterPerformanceVersion: values.candidate,
  fixtureSha256: createHash('sha256').update(readFileSync(fixturesFile)).digest('hex') };
console.log(JSON.stringify(plan));
if (values.live) {
  const root = resolve('.cache', 'character-performance', new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8));
  mkdirSync(root, { recursive: true });
  const store = new Store(join(root, 'npc-lab.sqlite'));
  const adapter = new OpenAIAdapter(join(root, 'runtime'), { maxOutputTokens: 2048 });
  const engine = new Engine(store, adapter, root);
  const dispose = interruptTest(() => engine);
  let calls = 0;
  const turn = adapter.turn.bind(adapter);
  adapter.turn = async (...args) => {
    const summaries = engine.list().map(r => r.summary.cost);
    if (calls >= maxCalls || summaries.some(c => c.unpricedCalls) || summaries.reduce((s,c) => s + (c.usd ?? 0), 0) >= plan.maxEstimatedUsd) throw Error('Experiment budget reached');
    calls++;
    return turn(...args);
  };
  const outputs = [];
  try {
    for (const [index, fixture] of cases.entries()) for (let rep = 1; rep <= repetitions; rep++) {
      const order = [values.candidate!, 'off'];
      if ((rep + index) % 2) order.reverse();
      for (const [arm, policy] of order.entries()) {
        const characters = values.split === 'migration' && policy !== 'off' ? harbor('harbor-profile/5') : fixture.characters;
        const spec = experimentSchema.parse({ schemaVersion: 1, name: fixture.id, scenario: { id: fixture.id, name: fixture.id, world: fixture.world,
          situation: fixture.situation, defaults: config, characters }, variants: [{ id: 'arm-' + arm, label: policy,
            characterPerformanceVersion: policy, dialoguePromptVersion: 'npc-dialogue/5', environmentMode: 'off' }],
          scheduledEvents: fixture.events, maxUtterances: turns, concurrentRuns: 1, maxConcurrentCalls: 1,
          evaluation: { enabled: false, ...config }, director: config });
        const { runs: [{ id }] } = await engine.create(spec);
        await engine.idle();
        const d = engine.detail(id);
        if (d.run.status !== 'completed') throw Error(d.run.error ?? d.run.status);
        outputs.push({ scene: fixture.id, repetition: rep, policy: d.run.variant.characterPerformanceVersion,
          sessions: Object.entries(d.run.sessions).map(([actor,s]) => ({ actor, choices: s.performance?.choices, source: s.performance?.source })),
          turns: d.utterances.map(u => ({ sequence: u.sequence, actor: u.speakerName, speech: u.speech, action: u.action })),
          calls: d.invocations.map(c => ({ actor: c.characterId, schema: c.metadata.outputSchemaSha256, instructions: c.metadata.instructionsSha256,
            recalled: c.metadata.recalledOwnUtteranceId != null,
            inputSha256: createHash('sha256').update(c.input).digest('hex'), output: c.output, usage: c.usage, model: c.actualModel })),
          estimatedUsd: d.summary.cost.usd });
      }
      writeFileSync(join(root, 'results.json'), JSON.stringify({ plan, outputs }, null, 2));
      console.log(JSON.stringify({ root, scene: fixture.id, rep, calls }));
    }
  } finally { await stopTestRuns(engine); await dispose(); await engine.close(); store.close(); }
}
