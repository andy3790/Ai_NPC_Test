import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { OpenAIAdapter } from '../src/adapters/openai.js';
import { baseInstructions } from '../src/core/prompts.js';
import { worldPolicies } from '../src/core/world-policies.js';
import { outputSchemas } from '../src/shared/schema.js';
import { getModelPricing, PRICING_REVISION } from '../src/shared/model-catalog.js';
import { sha256 } from './lib/dialogue-eval.js';
import { worldCasesSchema, inspectWorldResponse } from './lib/world-eval.js';
import { worldResponseContract } from '../src/core/world.js';

const { values } = parseArgs({ options: {
  live: { type: 'boolean', default: false }, cases: { type: 'string', default: 'evals/world/observations.json' },
  baseline: { type: 'string', default: 'npc-world/4' }, candidate: { type: 'string', default: 'npc-world/6' },
  split: { type: 'string', default: 'development' }, model: { type: 'string', default: 'gpt-6-luna' },
  effort: { type: 'string', default: 'medium' }, repetitions: { type: 'string', default: '2' },
  'max-calls': { type: 'string', default: '80' }, 'max-usd': { type: 'string', default: '1' },
} });
const repetitions = Number(values.repetitions), maxCalls = Number(values['max-calls']), maxUsd = Number(values['max-usd']);
type Version = keyof typeof worldPolicies;
const baseline = values.baseline as Version, candidate = values.candidate as Version;
if (!Object.hasOwn(worldPolicies, baseline) || !Object.hasOwn(worldPolicies, candidate) || baseline === candidate ||
    !['development', 'holdout', 'all'].includes(values.split!) || !Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 5 ||
    !Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 300 || !Number.isFinite(maxUsd) || maxUsd <= 0 || maxUsd > 5) throw new Error('Invalid limits or versions.');
const rawCases = await readFile(resolve(values.cases!), 'utf8');
const suite = worldCasesSchema.parse(JSON.parse(rawCases));
const cases = suite.cases.filter(c => values.split === 'all' || c.split === values.split);
const expectedCalls = cases.length * repetitions * 2;
if (!expectedCalls || expectedCalls > maxCalls) throw new Error(`Plan needs ${expectedCalls} calls, limit ${maxCalls}.`);
const plan = { suite: suite.version, casesSha256: sha256(rawCases), split: values.split, baseline, candidate, model: values.model!, effort: values.effort!,
  repetitions, expectedCalls, maxCalls, maxUsd, pricingRevision: PRICING_REVISION,
  baseSchemaSha256: sha256(JSON.stringify(outputSchemas.environment)), schemaMode: 'per-policy-and-action', review: 'Event presence and runtime validation are mechanical checks, not semantic correctness.' };
if (!values.live) console.log(JSON.stringify({ live: false, ...plan }, null, 2));
else {
  const root = resolve('.cache/world-eval', `${new Date().toISOString().replace(/[:.]/g, '-')}-${values.split}-${randomUUID().slice(0, 8)}`);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'cases.json'), rawCases);
  await writeFile(join(root, 'plan.json'), JSON.stringify(plan, null, 2));
  await writeFile(join(root, 'policies.json'), JSON.stringify({ baseInstructions, worldPolicies, schema: outputSchemas.environment }, null, 2));
  const adapter = new OpenAIAdapter(join(root, 'runtime'), { maxOutputTokens: 3072 });
  let calls = 0, estimatedUsd = 0, error: string | null = null;
  const samples: Record<string, unknown>[] = [];
  console.log(JSON.stringify({ root, ...plan }));
  try {
    const models = await adapter.models();
    if (!models.some(m => m.id === plan.model && m.efforts.includes(plan.effort))) throw new Error('Unavailable model/effort.');
    for (const [i, c] of cases.entries()) for (let repetition = 1; repetition <= repetitions; repetition++) {
      const versions = (i + repetition) % 2 ? [candidate, baseline] : [baseline, candidate];
      for (const [slot, version] of versions.entries()) {
        if (calls >= maxCalls || estimatedUsd >= maxUsd) throw new Error('World evaluation budget reached.');
        const instructions = worldPolicies[version].instructions;
        const threadId = await adapter.createSession(plan, instructions, root);
        const clientMessageId = randomUUID(); calls++;
        const outputSchema = worldResponseContract(version, JSON.parse(c.input).currentAction).outputSchema;
        const request = { threadId, config: plan, input: c.input, outputSchema, clientMessageId, timeoutMs: 90_000 };
        await appendFile(join(root, 'requests.jsonl'), JSON.stringify({ ...request, instructions: baseInstructions + '\n' + instructions }) + '\n');
        const started = performance.now();
        const result = await adapter.turn(request, () => {});
        const price = getModelPricing(result.actualModel ?? plan.model), usage = result.usage;
        const rate = price && usage?.inputTokens != null && price.longContext && usage.inputTokens > price.longContext.aboveInputTokens ? price.longContext : price;
        const cost = rate && usage?.inputTokens != null && usage.outputTokens != null ?
          ((usage.inputTokens - (usage.cachedInputTokens ?? 0)) * rate.input + (usage.cachedInputTokens ?? 0) * rate.cached + usage.outputTokens * rate.output) / 1_000_000 : null;
        const check = result.status === 'completed' ? inspectWorldResponse(c, result.output, version) : null;
        const sample = { caseId: c.id, repetition, slot: slot ? 'B' : 'A', version, clientMessageId, status: result.status,
          output: result.output, usage, actualModel: result.actualModel, costUsd: cost, durationMs: performance.now() - started,
          instructionsSha256: sha256(baseInstructions + '\n' + instructions), inputSha256: sha256(c.input), outputSchemaSha256: sha256(JSON.stringify(outputSchema)), outputSchema, error: result.error ?? null, check };
        samples.push(sample); await appendFile(join(root, 'samples.jsonl'), JSON.stringify(sample) + '\n');
        if (cost !== null) estimatedUsd += cost;
        console.log(JSON.stringify({ caseId: c.id, repetition, version, valid: check?.valid, eventExpectationMet: check?.eventExpectationMet, calls }));
        // Semantically invalid attempts are evidence; continue independent cases, never retry them.
        if (result.status !== 'completed' || cost === null) throw new Error('Provider failure or unpriced response; stop without retry.');
      }
    }
  } catch (e) { error = e instanceof Error ? e.message : String(e); process.exitCode = 1; }
  finally {
    await adapter.close();
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ ...plan, status: error ? 'incomplete' : 'completed', error, calls, estimatedUsd,
      quality: 'unreviewed', invalidOutputs: samples.filter(s => !(s.check as { valid?: boolean })?.valid).length }, null, 2));
    console.log(JSON.stringify({ root, calls, estimatedUsd, error }));
  }
}
