import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { OpenAIAdapter } from '../src/adapters/openai.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { UsageTracker } from '../src/core/metrics.js';
import { outputSchemas, speechSchema } from '../src/shared/schema.js';
import { getModelPricing, PRICING_REVISION } from '../src/shared/model-catalog.js';
import { baseInstructions, PROMPT_VERSION } from '../src/core/prompts.js';
import { dialoguePolicies } from '../src/core/dialogue-policies.js';
import { CURRENT_DIALOGUE_PROMPT, DIALOGUE_PROMPT_VERSIONS, type DialoguePromptVersion } from '../src/shared/dialogue-policy.js';
import { caseInput, dialogueCasesSchema, policyOrder, renderReview, sha256, type ReviewSample } from './lib/dialogue-eval.js';

const { values } = parseArgs({ options: {
  live: { type: 'boolean', default: false }, cases: { type: 'string', default: 'evals/dialogue/cases.json' },
  adapter: { type: 'string', default: 'openai' },
  baseline: { type: 'string', default: 'npc-dialogue/1' }, candidate: { type: 'string', default: CURRENT_DIALOGUE_PROMPT },
  split: { type: 'string', default: 'development' }, model: { type: 'string', default: 'gpt-6.1-sol' },
  effort: { type: 'string', default: 'low' }, repetitions: { type: 'string', default: '3' },
  'max-usd': { type: 'string', default: '2' }, 'max-calls': { type: 'string', default: '100' },
} });
const repetitions = Number(values.repetitions), maxUsd = Number(values['max-usd']), maxCalls = Number(values['max-calls']);
const baseline = values.baseline as DialoguePromptVersion, candidate = values.candidate as DialoguePromptVersion;
if (!DIALOGUE_PROMPT_VERSIONS.includes(baseline) || !DIALOGUE_PROMPT_VERSIONS.includes(candidate) || baseline === candidate) {
  throw new Error('Choose two different, known policy versions.');
}
if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 5 || !Number.isFinite(maxUsd) || maxUsd <= 0 || maxUsd > 10 ||
    !Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 500 || !['development', 'holdout', 'all'].includes(values.split!) ||
    !['openai', 'codex'].includes(values.adapter!)) {
  throw new Error('Invalid evaluation limits/split.');
}
const rawCases = await readFile(resolve(values.cases!), 'utf8');
const suite = dialogueCasesSchema.parse(JSON.parse(rawCases));
const cases = suite.cases.filter(c => values.split === 'all' || c.split === values.split);
if (!cases.length) throw new Error('The selected split has no cases.');
const expectedCalls = cases.length * repetitions * 2;
if (expectedCalls > maxCalls) throw new Error(`Plan needs ${expectedCalls} calls, limit is ${maxCalls}.`);
const plan = { adapter: values.adapter!, suiteVersion: suite.version, casesSha256: sha256(rawCases), split: values.split, model: values.model!, effort: values.effort!,
  promptVersion: PROMPT_VERSION, policyVersions: [baseline, candidate], repetitions, expectedCalls, maxCalls, maxUsd,
  pricingRevision: PRICING_REVISION, costLimit: 'Recorded catalogue estimate; one in-flight response can exceed maxUsd. No retry.' };
if (!values.live) console.log(JSON.stringify({ live: false, ...plan }, null, 2));
else {
  const root = resolve('.cache/dialogue-eval', `${new Date().toISOString().replace(/[:.]/g, '-')}-${values.split}-${randomUUID().slice(0, 8)}`);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'cases.json'), rawCases);
  await writeFile(join(root, 'policies.json'), JSON.stringify({ baseInstructions, policies: dialoguePolicies }, null, 2));
  await writeFile(join(root, 'plan.json'), JSON.stringify(plan, null, 2));
  const adapter = values.adapter === 'codex' ? new CodexAdapter(join(root, 'runtime')) : new OpenAIAdapter(join(root, 'runtime'), { maxOutputTokens: 2048 });
  let calls = 0, estimatedUsd = 0;
  const samples: (ReviewSample & Record<string, unknown>)[] = [];
  let status = 'completed', error: string | null = null;
  console.log(JSON.stringify({ root, ...plan }));
  try {
    const models = await adapter.models();
    if (!models.some(m => m.id === plan.model && m.efforts.includes(plan.effort))) throw new Error('Model/effort is unavailable.');
    for (const [index, c] of cases.entries()) for (let repetition = 1; repetition <= repetitions; repetition++) {
      for (const [slotIndex, version] of policyOrder(index, repetition, baseline, candidate).entries()) {
        if (calls >= maxCalls || estimatedUsd >= maxUsd) throw new Error('Evaluation budget reached.');
        const p = caseInput(c, version, plan.model, plan.effort);
        const threadId = await adapter.createSession(plan, p.instructions, root);
        const clientMessageId = randomUUID();
        calls++;
        // Save complete effective instructions, request and response for every attempt.
        await appendFile(join(root, 'requests.jsonl'), JSON.stringify({ caseId: c.id, repetition, version, clientMessageId,
          ...p, instructions: baseInstructions + '\n' + p.instructions, schema: outputSchemas.speech }) + '\n');
        const started = performance.now();
        const tracker = new UsageTracker(adapter.baseline(threadId));
        const events: unknown[] = [];
        const result = await adapter.turn({ threadId, config: plan, input: p.input, outputSchema: outputSchemas.speech,
          clientMessageId, timeoutMs: 90_000 }, event => {
          events.push(event);
          if (event.method === 'thread/tokenUsage/updated') tracker.update(event.params);
        });
        await appendFile(join(root, 'events.jsonl'), JSON.stringify({ clientMessageId, events }) + '\n');
        const price = getModelPricing(result.actualModel ?? plan.model);
        const usage = result.usage ?? tracker.result().usage;
        const rate = price && usage?.inputTokens != null && price.longContext && usage.inputTokens > price.longContext.aboveInputTokens ? price.longContext : price;
        const cost = rate && usage?.inputTokens != null && usage.outputTokens != null
          ? ((usage.inputTokens - (usage.cachedInputTokens ?? 0)) * rate.input + (usage.cachedInputTokens ?? 0) * rate.cached + usage.outputTokens * rate.output) / 1_000_000 : null;
        const valid = result.status === 'completed' && (() => { try { return speechSchema.safeParse(JSON.parse(result.output)).success; } catch { return false; } })();
        const sample = { caseId: c.id, repetition, slot: slotIndex ? 'B' : 'A', version, clientMessageId,
          status: valid ? 'completed' : result.status === 'completed' ? 'invalid_output' : result.status,
          output: result.output, usage: usage ?? null, actualModel: result.actualModel ?? null, costUsd: cost,
          durationMs: performance.now() - started, instructionsSha256: p.instructionsSha256, inputSha256: p.inputSha256, error: result.error ?? null };
        samples.push(sample);
        await appendFile(join(root, 'samples.jsonl'), JSON.stringify(sample) + '\n');
        if (cost !== null) estimatedUsd += cost;
        console.log(JSON.stringify({ caseId: c.id, repetition, slot: sample.slot, status: sample.status, calls, estimatedUsd }));
        if (!valid || cost === null) throw new Error('Failed, uncertain, invalid or unpriced response; stopped without retry. Inspect the saved attempt.');
      }
    }
  } catch (e) { status = 'incomplete'; error = e instanceof Error ? e.message : String(e); process.exitCode = 1; }
  finally {
    await adapter.close();
    await writeFile(join(root, 'review.md'), renderReview(cases, samples));
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ ...plan, status, error, calls, estimatedUsd,
      unpricedCalls: samples.filter(s => s.costUsd === null).length,
      quality: 'unreviewed', mappings: samples.map(s => ({ caseId: s.caseId, repetition: s.repetition, slot: s.slot, version: s.version })) }, null, 2));
    console.log(JSON.stringify({ root, status, error, calls, estimatedUsd }));
  }
}
