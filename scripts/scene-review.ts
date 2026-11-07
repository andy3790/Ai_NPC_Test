import { existsSync } from 'node:fs';
import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { OpenAIAdapter } from '../src/adapters/openai.js';
import { Engine } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
import { experimentSchema } from '../src/shared/schema.js';
import { ReviewBudget, reviewBudgetFile } from './review-budget.js';

const { values } = parseArgs({ options: {
  spec: { type:'string' }, label: { type:'string' }, turns: { type:'string' }, group: { type:'string' }, variant:{type:'string'},
  usd: { type:'string' }, npc: { type:'string', default:'gpt-6-luna' }, sparse: { type:'boolean' }, minimal:{ type:'boolean' },
  live: { type:'boolean' }, resume:{type:'boolean'}, evaluate:{type:'boolean'}, 'until-limit':{type:'boolean'},
} });
const turns = Number(values.turns);
if (!values.spec || !values.label || !values.group || ![values.label, values.group].every(s => /^[\w-]{1,80}$/.test(s))
  || !Number.isSafeInteger(turns) || turns < 1
  || !['gpt-6-luna','gpt-6.1-terra'].includes(values.npc)) throw Error('Provide spec, group, unique label, turns and a supported NPC model.');
const root = resolve('.cache','scene-review', values.group), dir = join(root, values.label);
const spec = experimentSchema.parse(JSON.parse(await readFile(resolve(values.spec), 'utf8')));
spec.maxUtterances = turns; spec.repetitions = 1; spec.concurrentRuns = 1; spec.evaluation.enabled = !!values.evaluate;
spec.scenario.defaults = { model: values.npc, effort:'low' };
spec.director = { model:'gpt-6-luna', effort:'low' };
if (spec.worldEngine) spec.worldEngine = { model:'gpt-6-luna', effort:'medium' };
if (spec.eventGenerator) Object.assign(spec.eventGenerator, spec.director);
Object.assign(spec.evaluation, spec.director);
const variant = values.variant ? spec.variants.find(v => v.id === values.variant) : spec.variants[0];
if (!variant) throw Error('Unknown variant.');
spec.variants = [variant]; delete variant.model; delete variant.effort;
if (values['until-limit']) delete variant.stopOnSilence;
for (const c of spec.scenario.characters) {
  delete c.model; delete c.effort;
  if (values.sparse) { c.speechStyle = ''; c.exampleDialogue = ''; c.behaviors = ''; c.taboos = ''; }
  if (values.minimal) {
    c.identity = c.identity.split(/[.\n]/)[0]; c.goals = c.goals.split(/[.\n]/)[0];
    for (const field of ['speechStyle','exampleDialogue','behaviors','taboos','memories','relationships','personality','values','knowledge','unknowns'] as const) c[field] = '';
  }
}
experimentSchema.parse(spec);
if (!values.live) { console.log(JSON.stringify({ name:spec.name, turns, variant:spec.variants[0], model:spec.scenario.defaults })); process.exit(0); }
await mkdir(root, { recursive:true }); if (!values.resume) await mkdir(dir);
const dbFile = join(dir, 'npc-lab.sqlite');
if (values.resume) {
  if (!existsSync(dbFile) || !isDeepStrictEqual(JSON.parse(await readFile(join(dir,'config.json'),'utf8')),spec)) throw Error('Resume requires the same frozen specification.');
} else await writeFile(join(dir,'config.json'), JSON.stringify(spec,null,2));
const lock = join(dir,'active.lock'); const handle = await open(lock,'wx'); await handle.close();
try {
  using budget = new ReviewBudget(reviewBudgetFile(root), Number(values.usd));
  const store = new Store(dbFile);
  try {
    const adapter = new OpenAIAdapter(join(dir,'runtime'), { fetch:budget.fetch, maxOutputTokens:4096 });
    const turn = adapter.turn.bind(adapter);
    adapter.turn = async (...args) => { const result = await turn(...args); budget.settle(args[0].clientMessageId,result); return result; };
    const previous = store.list('runs')[0];
    if (values.resume && previous?.status !== 'paused') throw Error('Only a paused run can be resumed.');
    const engine = new Engine(store, adapter, dir);
    try {
      const r = values.resume ? previous : (await engine.create(spec)).runs[0];
      if (values.resume) await engine.resume(r.id);
      await engine.idle();
      const {run,summary} = engine.detail(r.id);
      console.log(JSON.stringify({ label:values.label, status:run.status, choices:summary.speechCount, cost:summary.cost.usd, aggregate:budget.total(), error:run.error?.replace(/resp_[\w-]+/g,'[redacted]') }));
      if (run.status !== 'completed') process.exitCode = 1;
    } finally { await engine.close(); }
  } finally { store.close(); }
} finally { await unlink(lock); }
