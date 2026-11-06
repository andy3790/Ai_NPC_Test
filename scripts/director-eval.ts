import { randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { OpenAIAdapter } from '../src/adapters/openai.js';
import { legacyDirectorInstructions as directorInstructions, directorOutputSchema, directorPrompt } from '../src/core/director.js';
import { baseInstructions } from '../src/core/prompts.js';
import { directorSchema, outputSchemas } from '../src/shared/schema.js';
import { getModelPricing, PRICING_REVISION } from '../src/shared/model-catalog.js';
import { sha256 } from './lib/dialogue-eval.js';

const { values } = parseArgs({ options: { live: { type: 'boolean', default: false },
  comparison: { type: 'string', default: 'schema' },
  cases: { type: 'string', default: 'evals/director/selection.json' }, repetitions: { type: 'string', default: '5' },
  'max-calls': { type: 'string', default: '40' }, 'max-usd': { type: 'string', default: '1' } } });
const repetitions = Number(values.repetitions), maxCalls = Number(values['max-calls']), maxUsd = Number(values['max-usd']);
if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 10 || !Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 100 ||
    !Number.isFinite(maxUsd) || maxUsd <= 0 || maxUsd > 2) throw new Error('Invalid replay limits.');
if (!['schema', 'context'].includes(values.comparison!)) throw Error('Unknown comparison.');
const raw = await readFile(resolve(values.cases!), 'utf8');
const suite = JSON.parse(raw) as { version: string; instructionsSha256: string; cases: { id: string; input: string;
  options?: Parameters<typeof directorPrompt>[0]; expectedSpeakerId?: string }[] };
if (sha256(directorInstructions) !== suite.instructionsSha256) throw new Error('Instruction text changed; this comparison must keep it fixed.');
if (!suite.cases.length || new Set(suite.cases.map(c => c.id)).size !== suite.cases.length) throw new Error('Invalid case IDs.');
for (const c of suite.cases) {
  const p = JSON.parse(c.input);
  if (p.task !== 'direct' || !Array.isArray(p.allowedSpeakerIds) || !p.allowedSpeakerIds.length || p.allowedSpeakerIds.some((id: unknown) => typeof id !== 'string')) throw new Error('Invalid director input.');
  if (values.comparison === 'context') {
    if (!c.options?.initialScene || !c.expectedSpeakerId || !p.allowedSpeakerIds.includes(c.expectedSpeakerId)) throw Error('Invalid context case.');
    const baseline = directorPrompt({ ...c.options, version: 'director/3' });
    if (baseline.input !== c.input) throw Error('Context case does not reproduce original baseline input.');
    directorPrompt({ ...c.options, version: 'director/4' });
  }
}
const plan = { suite: suite.version, casesSha256: sha256(raw), model: 'gpt-6-luna', effort: 'low', repetitions,
  comparison: values.comparison,
  expectedCalls: suite.cases.length * repetitions * 2, maxCalls, maxUsd, pricingRevision: PRICING_REVISION,
  review: values.comparison === 'context' ? 'Opening-scene recipient selection and explicit-topic-change regression. Not a naturalness or character-voice score. New session per sample. No retry.' :
    'Allowed-speaker compliance only; no naturalness score. New session per sample. No retry.' };
if (plan.expectedCalls > maxCalls) throw new Error('Replay exceeds call limit.');
if (!values.live) console.log(JSON.stringify({ live: false, ...plan }, null, 2));
else {
  const root = resolve('.cache/director-eval', new Date().toISOString().replace(/[:.]/g, '-'));
  await mkdir(root, { recursive: true }); await writeFile(join(root, 'cases.json'), raw);
  await writeFile(join(root, 'instructions.txt'), baseInstructions + '\n' + directorInstructions);
  const adapter = new OpenAIAdapter(join(root, 'runtime'), { maxOutputTokens: 1024 });
  let calls = 0, estimatedUsd = 0, error: string | null = null;
  console.log(JSON.stringify({ root, ...plan }));
  try {
    const models = await adapter.models();
    if (!models.some(m => m.id === plan.model && m.efforts.includes(plan.effort))) throw new Error('Unavailable model/effort.');
    for (const [index, c] of suite.cases.entries()) for (let repetition = 1; repetition <= repetitions; repetition++) {
      const allowed = JSON.parse(c.input).allowedSpeakerIds as string[];
      const versions = values.comparison === 'context' ? ['director/3', 'director/4'] as const : ['director/2', 'director/3'] as const;
      for (const version of (index + repetition) % 2 ? [...versions].reverse() : versions) {
        if (calls >= maxCalls || estimatedUsd >= maxUsd) throw new Error('Replay budget reached.');
        const prompt = values.comparison === 'context' ? directorPrompt({ ...c.options!, version: version as 'director/3' | 'director/4' }) : null;
        const instructions = prompt?.instructions ?? directorInstructions, input = prompt?.input ?? c.input;
        const outputSchema = prompt?.outputSchema ?? (version === 'director/3' ? directorOutputSchema(allowed) : outputSchemas.director);
        const threadId = await adapter.createSession(plan, instructions, root), clientMessageId = randomUUID(); calls++;
        await appendFile(join(root, 'requests.jsonl'), JSON.stringify({ caseId: c.id, repetition, version, clientMessageId,
          input, instructions: baseInstructions + '\n' + instructions, outputSchema }) + '\n');
        const result = await adapter.turn({ threadId, config: plan, input, outputSchema, clientMessageId, timeoutMs: 90_000 }, () => {});
        const price = getModelPricing(result.actualModel ?? plan.model), u = result.usage;
        const rate = price && u?.inputTokens != null && price.longContext && u.inputTokens > price.longContext.aboveInputTokens ? price.longContext : price;
        const cost = rate && u?.inputTokens != null && u.outputTokens != null ? ((u.inputTokens - (u.cachedInputTokens ?? 0)) * rate.input + (u.cachedInputTokens ?? 0) * rate.cached + u.outputTokens * rate.output) / 1_000_000 : null;
        let valid = false;
        try { valid = result.status === 'completed' && allowed.includes(directorSchema.parse(JSON.parse(result.output)).speakerId); } catch { /* preserve invalid response */ }
        const sample = { caseId: c.id, repetition, version, clientMessageId, status: result.status, output: result.output, valid,
          ...(c.expectedSpeakerId ? { correctRecipient: valid && JSON.parse(result.output).speakerId === c.expectedSpeakerId } : {}),
          actualModel: result.actualModel, usage: u, costUsd: cost, error: result.error ?? null, inputSha256: sha256(input),
          instructionsSha256: sha256(baseInstructions + '\n' + instructions), outputSchema, outputSchemaSha256: sha256(JSON.stringify(outputSchema)) };
        await appendFile(join(root, 'samples.jsonl'), JSON.stringify(sample) + '\n');
        if (cost !== null) estimatedUsd += cost;
        console.log(JSON.stringify({ caseId: c.id, repetition, version, valid, calls }));
        if (result.status !== 'completed' || cost === null) throw new Error('Provider/usage failure; no retry.');
      }
    }
  } catch (e) { error = e instanceof Error ? e.message : String(e); process.exitCode = 1; }
  finally {
    await adapter.close(); await writeFile(join(root, 'manifest.json'), JSON.stringify({ ...plan, status: error ? 'incomplete' : 'completed', calls, estimatedUsd, error }, null, 2));
    console.log(JSON.stringify({ root, calls, estimatedUsd, error }));
  }
}
