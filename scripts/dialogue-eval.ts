import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { OpenAIAdapter } from '../src/adapters/openai.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { TestSessions } from './lib/test-sessions.js';
import { UsageTracker } from '../src/core/metrics.js';
import { outputSchemas, speechSchema } from '../src/shared/schema.js';
import { getModelPricing, PRICING_REVISION } from '../src/shared/model-catalog.js';
import { baseInstructions, PROMPT_VERSION } from '../src/core/prompts.js';
import { dialoguePolicies } from '../src/core/dialogue-policies.js';
import { CURRENT_DIALOGUE_PROMPT, DIALOGUE_PROMPT_VERSIONS, type DialoguePromptVersion } from '../src/shared/dialogue-policy.js';
import { caseInput, dialogueCasesSchema, renderReview, sha256, validateProfilePair, type ReviewSample } from './lib/dialogue-eval.js';

const { values } = parseArgs({ options: {
  live: { type: 'boolean', default: false }, cases: { type: 'string', default: 'evals/dialogue/cases.json' },
  'candidate-cases': { type: 'string' },
  adapter: { type: 'string', default: 'openai' },
  baseline: { type: 'string', default: 'npc-dialogue/1' }, candidate: { type: 'string', default: CURRENT_DIALOGUE_PROMPT },
  split: { type: 'string', default: 'development' }, model: { type: 'string', default: 'gpt-6-luna' },
  effort: { type: 'string', default: 'low' }, repetitions: { type: 'string', default: '3' },
  'candidate-model': { type: 'string' }, 'candidate-effort': { type: 'string' },
  'max-usd': { type: 'string', default: '2' }, 'max-calls': { type: 'string', default: '100' },
} });
const repetitions = Number(values.repetitions), maxUsd = Number(values['max-usd']), maxCalls = Number(values['max-calls']);
const baseline = values.baseline as DialoguePromptVersion, candidate = values.candidate as DialoguePromptVersion;
const conditions = [
  { id: 'baseline', policy: baseline, model: values.model!, effort: values.effort! },
  { id: 'candidate', policy: candidate, model: values['candidate-model'] ?? values.model!, effort: values['candidate-effort'] ?? values.effort! },
];
if (!DIALOGUE_PROMPT_VERSIONS.includes(baseline) || !DIALOGUE_PROMPT_VERSIONS.includes(candidate) ||
    (baseline === candidate && conditions[0].model === conditions[1].model && conditions[0].effort === conditions[1].effort && !values['candidate-cases'])) {
  throw new Error('Choose two different conditions using known policy versions.');
}
if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 5 || !Number.isFinite(maxUsd) || maxUsd <= 0 || maxUsd > 10 ||
    !Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 500 || !['development', 'holdout', 'all'].includes(values.split!) ||
    !['openai', 'codex'].includes(values.adapter!)) {
  throw new Error('Invalid evaluation limits/split.');
}
const rawCases = await readFile(resolve(values.cases!), 'utf8');
const suite = dialogueCasesSchema.parse(JSON.parse(rawCases));
const rawCandidateCases = values['candidate-cases'] ? await readFile(resolve(values['candidate-cases']), 'utf8') : null;
const candidateSuite = rawCandidateCases ? dialogueCasesSchema.parse(JSON.parse(rawCandidateCases)) : suite;
if (candidateSuite.cases.length !== suite.cases.length) throw Error('Candidate cases must contain exactly the baseline case IDs.');
for (const c of suite.cases) {
  const other = candidateSuite.cases.find(o => o.id === c.id);
  if (!other) throw Error('Missing candidate case: ' + c.id);
  validateProfilePair(c, other);
}
const cases = suite.cases.filter(c => values.split === 'all' || c.split === values.split);
if (!cases.length) throw new Error('The selected split has no cases.');
if (baseline === candidate && conditions[0].model === conditions[1].model && conditions[0].effort === conditions[1].effort &&
    cases.every(c => caseInput(c, baseline, conditions[0].model, conditions[0].effort).instructions ===
      caseInput(candidateSuite.cases.find(o => o.id === c.id)!, candidate, conditions[1].model, conditions[1].effort).instructions)) throw Error('Selected conditions produce identical requests.');
const expectedCalls = cases.length * repetitions * 2;
if (expectedCalls > maxCalls) throw new Error(`Plan needs ${expectedCalls} calls, limit is ${maxCalls}.`);
const plan = { adapter: values.adapter!, suiteVersion: suite.version, casesSha256: sha256(rawCases), split: values.split, model: values.model!, effort: values.effort!,
  promptVersion: PROMPT_VERSION, policyVersions: [baseline, candidate], conditions, repetitions, expectedCalls, maxCalls, maxUsd,
  candidateSuiteVersion: candidateSuite.version, candidateCasesSha256: sha256(rawCandidateCases ?? rawCases),
  pricingRevision: PRICING_REVISION, costLimit: 'Recorded catalogue estimate; one in-flight response can exceed maxUsd. No retry.' };
if (!values.live) console.log(JSON.stringify({ live: false, ...plan }, null, 2));
else {
  const root = resolve('.cache/dialogue-eval', `${new Date().toISOString().replace(/[:.]/g, '-')}-${values.split}-${randomUUID().slice(0, 8)}`);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'cases.json'), rawCases);
  if (rawCandidateCases) await writeFile(join(root, 'candidate-cases.json'), rawCandidateCases);
  await writeFile(join(root, 'policies.json'), JSON.stringify({ baseInstructions, policies: dialoguePolicies }, null, 2));
  await writeFile(join(root, 'plan.json'), JSON.stringify(plan, null, 2));
  const adapter = values.adapter === 'codex' ? new CodexAdapter(join(root, 'runtime')) : new OpenAIAdapter(join(root, 'runtime'), { maxOutputTokens: 2048 });
  const sessions = new TestSessions(adapter, root);
  let calls = 0, estimatedUsd = 0;
  const samples: (ReviewSample & Record<string, unknown>)[] = [];
  let status = 'completed', error: string | null = null;
  console.log(JSON.stringify({ root, ...plan }));
  try {
    const models = await adapter.models();
    for (const c of conditions) if (!models.some(m => m.id === c.model && m.efforts.includes(c.effort))) throw new Error('Model/effort is unavailable for ' + c.id);
    for (const [index, c] of cases.entries()) for (let repetition = 1; repetition <= repetitions; repetition++) {
      const ordered = (index + repetition) % 2 ? [...conditions].reverse() : conditions;
      for (const [slotIndex, condition] of ordered.entries()) {
        const version = condition.policy;
        if (calls >= maxCalls || estimatedUsd >= maxUsd) throw new Error('Evaluation budget reached.');
        const selectedCase = condition.id === 'candidate' ? candidateSuite.cases.find(o => o.id === c.id)! : c;
        const p = caseInput(selectedCase, version, condition.model, condition.effort);
        const threadId = await sessions.create(condition, p.instructions);
        const clientMessageId = randomUUID();
        calls++;
        // Save complete effective instructions, request and response for every attempt.
        await appendFile(join(root, 'requests.jsonl'), JSON.stringify({ caseId: c.id, repetition, version, conditionId: condition.id, config: condition, clientMessageId,
          threadId, ...p, instructions: baseInstructions + '\n' + p.instructions, schema: outputSchemas.speech }) + '\n');
        const started = performance.now();
        const tracker = new UsageTracker(adapter.baseline(threadId));
        const events: unknown[] = [];
        const result = await adapter.turn({ threadId, config: condition, input: p.input, outputSchema: outputSchemas.speech,
          clientMessageId, timeoutMs: 90_000 }, event => {
          events.push(event);
          if (event.method === 'thread/tokenUsage/updated') tracker.update(event.params);
        }, sessions.signal);
        await appendFile(join(root, 'events.jsonl'), JSON.stringify({ clientMessageId, events }) + '\n');
        const price = getModelPricing(result.actualModel ?? condition.model);
        const usage = result.usage ?? tracker.result().usage;
        const rate = price && usage?.inputTokens != null && price.longContext && usage.inputTokens > price.longContext.aboveInputTokens ? price.longContext : price;
        const cost = rate && usage?.inputTokens != null && usage.outputTokens != null
          ? ((usage.inputTokens - (usage.cachedInputTokens ?? 0)) * rate.input + (usage.cachedInputTokens ?? 0) * rate.cached + usage.outputTokens * rate.output) / 1_000_000 : null;
        const valid = result.status === 'completed' && (() => { try { return speechSchema.safeParse(JSON.parse(result.output)).success; } catch { return false; } })();
        const sample = { caseId: c.id, repetition, slot: slotIndex ? 'B' : 'A', version, conditionId: condition.id,
          model: condition.model, effort: condition.effort, clientMessageId,
          status: valid ? 'completed' : result.status === 'completed' ? 'invalid_output' : result.status,
          output: result.output, usage: usage ?? null, actualModel: result.actualModel ?? null, costUsd: cost,
          durationMs: performance.now() - started, instructionsSha256: p.instructionsSha256, inputSha256: p.inputSha256, error: result.error ?? null };
        samples.push(sample);
        await appendFile(join(root, 'samples.jsonl'), JSON.stringify(sample) + '\n');
        await sessions.release(threadId);
        if (cost !== null) estimatedUsd += cost;
        console.log(JSON.stringify({ caseId: c.id, repetition, slot: sample.slot, status: sample.status, calls, estimatedUsd }));
        if (!valid || cost === null) throw new Error('Failed, uncertain, invalid or unpriced response; stopped without retry. Inspect the saved attempt.');
      }
    }
  } catch (e) { status = 'incomplete'; error = e instanceof Error ? e.message : String(e); process.exitCode = 1; }
  finally {
    const cleanupErrors = await sessions.close();
    await adapter.close();
    await writeFile(join(root, 'review.md'), renderReview(cases, samples));
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ ...plan, status, error, calls, estimatedUsd, cleanupErrors,
      unpricedCalls: samples.filter(s => s.costUsd === null).length,
      quality: 'unreviewed', mappings: samples.map(s => ({ caseId: s.caseId, repetition: s.repetition, slot: s.slot, version: s.version,
        conditionId: s.conditionId, model: s.model, effort: s.effort })) }, null, 2));
    console.log(JSON.stringify({ root, status, error, calls, estimatedUsd }));
  }
}
