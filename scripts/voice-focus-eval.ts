import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { OpenAIAdapter } from '../src/adapters/openai.js';
import { speechSchema, outputSchemas } from '../src/shared/schema.js';
import { baseInstructions } from '../src/core/prompts.js';
import { getModelPricing, PRICING_REVISION } from '../src/shared/model-catalog.js';
import { caseInput, dialogueCasesSchema, sha256 } from './lib/dialogue-eval.js';

// A bounded experiment, not the production Engine. Compare the same /7 persona
// with and without one fictional role-focus field before integrating a schema.
const { values } = parseArgs({ options: { model: { type: 'string', default: 'gpt-6-luna' }, live: { type: 'boolean', default: false },
  cases: { type: 'string', default: 'evals/dialogue/voice-contrast.json' }, split: { type: 'string', default: 'development' },
  repetitions: { type: 'string', default: '2' }, 'max-calls': { type: 'string', default: '32' }, 'max-usd': { type: 'string', default: '1' } } });
const repetitions = Number(values.repetitions), maxCalls = Number(values['max-calls']), maxUsd = Number(values['max-usd']);
if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 3 || !Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 100 ||
    !Number.isFinite(maxUsd) || maxUsd <= 0 || maxUsd > 2 || !['development', 'holdout', 'all'].includes(values.split!)) throw Error('Invalid limits.');
const raw = await readFile(resolve(values.cases!), 'utf8'), suite = dialogueCasesSchema.parse(JSON.parse(raw));
const cases = suite.cases.filter(c => values.split === 'all' || c.split === values.split);
const rawFocus = await readFile(resolve('evals/dialogue/reaction-focus.json'), 'utf8');
const focus = JSON.parse(rawFocus) as { version: string; parent: 'npc-dialogue/7'; instructions: string; fieldDescription: string };
if (focus.parent !== 'npc-dialogue/7' || !focus.instructions || !focus.fieldDescription) throw Error('Invalid focus policy.');
const focused = z.object({ reactionFocus: z.string().trim().min(1).max(160).describe(focus.fieldDescription),
  speech: speechSchema.shape.speech, action: speechSchema.shape.action });
const plan = { suite: suite.version, casesSha256: sha256(raw), focusVersion: focus.version, focusSha256: sha256(rawFocus),
  model: values.model!, effort: 'low', split: values.split, repetitions, expectedCalls: cases.length * repetitions * 2, maxCalls, maxUsd,
  pricingRevision: PRICING_REVISION, schemaVersion: 'reaction-focus-output/1', scope: 'Fixed input prototype; no production Engine or private-state delivery claims.' };
if (!cases.length || plan.expectedCalls > maxCalls) throw Error('Plan exceeds call limit.');
if (!values.live) console.log(JSON.stringify({ live: false, ...plan }, null, 2));
else {
  const root = resolve('.cache/voice-focus-eval', new Date().toISOString().replace(/[:.]/g, '-')); await mkdir(root, { recursive: true });
  await writeFile(join(root, 'cases.json'), raw); await writeFile(join(root, 'focus.json'), rawFocus); await writeFile(join(root, 'plan.json'), JSON.stringify(plan, null, 2));
  const adapter = new OpenAIAdapter(join(root, 'runtime'), { maxOutputTokens: 2048 });
  let calls = 0, estimatedUsd = 0, unpricedCalls = 0, error: string | null = null;
  console.log(JSON.stringify({ root, ...plan }));
  try {
    const models = await adapter.models(); if (!models.some(m => m.id === plan.model && m.efforts.includes(plan.effort))) throw Error('Unavailable model/effort.');
    for (const [index, c] of cases.entries()) for (let repetition = 1; repetition <= repetitions; repetition++) {
      for (const useFocus of (index + repetition) % 2 ? [true, false] : [false, true]) {
        if (calls >= maxCalls || estimatedUsd >= maxUsd) throw Error('Budget reached; no retry.');
        const p = caseInput(c, focus.parent, plan.model, plan.effort), version = useFocus ? `${focus.parent}+${focus.version}` : focus.parent;
        const instructions = p.instructions + (useFocus ? '\n\n' + focus.instructions : '');
        const outputSchema = useFocus ? z.toJSONSchema(focused) : outputSchemas.speech;
        const threadId = await adapter.createSession(plan, instructions, root), clientMessageId = randomUUID();
        await appendFile(join(root, 'requests.jsonl'), JSON.stringify({ caseId: c.id, repetition, version, clientMessageId,
          instructions: baseInstructions + '\n' + instructions, input: p.input, outputSchema }) + '\n');
        const start = performance.now(); calls++;
        const result = await adapter.turn({ threadId, config: plan, input: p.input, outputSchema, clientMessageId, timeoutMs: 90_000 }, () => {});
        const u = result.usage, price = getModelPricing(result.actualModel ?? plan.model);
        const rate = price && u?.inputTokens != null && price.longContext && u.inputTokens > price.longContext.aboveInputTokens ? price.longContext : price;
        const cost = rate && u?.inputTokens != null && u.outputTokens != null ? ((u.inputTokens - (u.cachedInputTokens ?? 0)) * rate.input +
          (u.cachedInputTokens ?? 0) * rate.cached + u.outputTokens * rate.output) / 1_000_000 : null;
        let valid = false; try { valid = result.status === 'completed' && (useFocus ? focused : speechSchema).safeParse(JSON.parse(result.output)).success; } catch { /* keep raw output */ }
        const sample = { caseId: c.id, repetition, version, status: result.status, valid, output: result.output, actualModel: result.actualModel,
          usage: u, costUsd: cost, durationMs: performance.now() - start, error: result.error ?? null,
          inputSha256: p.inputSha256, instructionsSha256: sha256(baseInstructions + '\n' + instructions), outputSchemaSha256: sha256(JSON.stringify(outputSchema)) };
        await appendFile(join(root, 'samples.jsonl'), JSON.stringify(sample) + '\n');
        if (cost !== null) estimatedUsd += cost; else unpricedCalls++;
        console.log(JSON.stringify({ caseId: c.id, repetition, version, valid, calls }));
        if (!valid || cost === null) throw Error('Invalid, failed or unpriced response; no retry.');
      }
    }
  } catch (e) { error = e instanceof Error ? e.message : String(e); process.exitCode = 1; }
  finally {
    await adapter.close(); await writeFile(join(root, 'manifest.json'), JSON.stringify({ ...plan, status: error ? 'incomplete' : 'completed', error, calls, estimatedUsd, unpricedCalls }, null, 2));
    console.log(JSON.stringify({ root, calls, estimatedUsd, error }));
  }
}
