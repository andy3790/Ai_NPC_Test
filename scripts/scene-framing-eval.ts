import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { OpenAIAdapter } from '../src/adapters/openai.js';
import { baseInstructions } from '../src/core/prompts.js';
import { outputSchemas, speechSchema } from '../src/shared/schema.js';
import { getModelPricing, PRICING_REVISION } from '../src/shared/model-catalog.js';
import { dialogueCasesSchema, sha256 } from './lib/dialogue-eval.js';
import { loadVoiceProfile, withVoiceProfile } from './lib/voice-profiles.js';

const { values } = parseArgs({ options: { source: { type: 'string' }, live: { type: 'boolean', default: false },
  profile: { type: 'string', default: 'seowol-profile/3' }, 'max-calls': { type: 'string', default: '20' },
  'max-usd': { type: 'string', default: '1' } } });
if (!values.source) throw Error('--source is required');
const maxCalls = Number(values['max-calls']), maxUsd = Number(values['max-usd']);
if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 40 || !Number.isFinite(maxUsd) || maxUsd <= 0 || maxUsd > 2) throw Error('Invalid limits');
const source = resolve(values.source), rawCases = await readFile(join(source, 'cases.json'), 'utf8');
const suite = dialogueCasesSchema.parse(JSON.parse(rawCases));
const rawSamples = await readFile(join(source, 'samples.jsonl'), 'utf8');
const sourceSample = z.object({ caseId: z.string(), repetition: z.number(), version: z.string(), status: z.string(), output: z.string() });
const samples = rawSamples.trim().split('\n').map(s => sourceSample.parse(JSON.parse(s)))
  .filter(s => s.status === 'completed' && s.version === values.profile);
if (!samples.length || samples.length > maxCalls) throw Error('Plan exceeds limits or has no source responses');
const rawPolicy = await readFile('evals/dialogue/scene-framing.json', 'utf8');
const policy = z.object({ version: z.string(), instructions: z.string() }).parse(JSON.parse(rawPolicy));
const profile = loadVoiceProfile(values.profile!);
const sourceProfiles = JSON.parse(await readFile(join(source, 'profiles.json'), 'utf8')) as { version: string; hashes: typeof profile.hashes }[];
const sourceProfile = sourceProfiles.find(p => p.version === profile.version);
if (!sourceProfile || JSON.stringify(sourceProfile.hashes) !== JSON.stringify(profile.hashes)) throw Error('Source profile changed after draft generation');
const plan = { version: policy.version, policySha256: sha256(rawPolicy), source: values.source,
  sourceSamplesSha256: sha256(rawSamples), casesSha256: sha256(rawCases), profile: profile.version, profileHashes: profile.hashes,
  model: 'gpt-6.1-sol', effort: 'low', expectedCalls: samples.length, maxCalls, maxUsd, pricingRevision: PRICING_REVISION,
  scope: 'New independent outputs with the same public observations and own profile. Baseline comes from a completed earlier run; order is not counterbalanced.' };
// Compile and validate every case before starting a paid call.
const requests = samples.map(s => {
  const c = suite.cases.find(c => c.id === s.caseId);
  if (!c) throw Error('Missing source case');
  const actor = withVoiceProfile(c.characters.find(a => a.id === c.speakerId)!, profile);
  const instructions = policy.instructions + '\n\n이번 화자의 설정:\n' + JSON.stringify(actor) + '\n\n함께 아는 배경:\n' + c.world +
    '\n\n대화가 시작했을 때의 장면:\n' + c.situation + '\n\n참가자:\n' + JSON.stringify(c.characters.map(a => ({ id: a.id, name: a.name })));
  const input = '지금까지 실제로 오간 말과 행동:\n' + c.history.map(h => c.characters.find(a => a.id === h.speakerId)!.name + ': ' + h.speech +
    (h.action ? '\n[행동] ' + h.action : '')).join('\n\n') + '\n\n다음 차례의 화자: ' + actor.name;
  return { caseId: c.id, repetition: s.repetition, instructions, input };
});
if (!values.live) console.log(JSON.stringify({ live: false, ...plan }, null, 2));
else {
  const root = resolve('.cache/scene-framing', new Date().toISOString().replace(/[:.]/g, '-')); await mkdir(root, { recursive: true });
  await writeFile(join(root, 'plan.json'), JSON.stringify(plan, null, 2)); await writeFile(join(root, 'cases.json'), rawCases);
  await writeFile(join(root, 'policy.json'), rawPolicy); await writeFile(join(root, 'profile.json'), JSON.stringify(profile, null, 2));
  await writeFile(join(root, 'source-samples.jsonl'), rawSamples);
  const adapter = new OpenAIAdapter(join(root, 'runtime'), { maxOutputTokens: 2048 });
  let calls = 0, estimatedUsd = 0, unpricedCalls = 0, error: string | null = null;
  console.log(JSON.stringify({ root, ...plan }));
  try {
    const models = await adapter.models(); if (!models.some(m => m.id === plan.model && m.efforts.includes(plan.effort))) throw Error('Unavailable model');
    for (const r of requests) {
      if (calls >= maxCalls || estimatedUsd >= maxUsd) throw Error('Budget reached');
      const threadId = await adapter.createSession(plan, r.instructions, root), clientMessageId = randomUUID();
      await appendFile(join(root, 'requests.jsonl'), JSON.stringify({ ...r, clientMessageId, instructions: baseInstructions + '\n' + r.instructions, outputSchema: outputSchemas.speech }) + '\n');
      calls++; const started = performance.now();
      const result = await adapter.turn({ threadId, config: plan, input: r.input, outputSchema: outputSchemas.speech, clientMessageId, timeoutMs: 90_000 }, () => {});
      const u = result.usage, p = getModelPricing(result.actualModel ?? plan.model);
      const rate = p && u?.inputTokens != null && p.longContext && u.inputTokens > p.longContext.aboveInputTokens ? p.longContext : p;
      const cost = rate && u?.inputTokens != null && u.outputTokens != null ? ((u.inputTokens - (u.cachedInputTokens ?? 0)) * rate.input + (u.cachedInputTokens ?? 0) * rate.cached + u.outputTokens * rate.output) / 1_000_000 : null;
      let valid = false; try { valid = result.status === 'completed' && speechSchema.safeParse(JSON.parse(result.output)).success; } catch { /* preserve raw */ }
      await appendFile(join(root, 'samples.jsonl'), JSON.stringify({ caseId: r.caseId, repetition: r.repetition, clientMessageId, status: result.status, valid,
        output: result.output, usage: u, actualModel: result.actualModel, costUsd: cost, durationMs: performance.now() - started, error: result.error ?? null,
        inputSha256: sha256(r.input), instructionsSha256: sha256(baseInstructions + '\n' + r.instructions) }) + '\n');
      if (cost !== null) estimatedUsd += cost; else unpricedCalls++;
      console.log(JSON.stringify({ caseId: r.caseId, repetition: r.repetition, calls, valid }));
      if (!valid || cost === null) throw Error('Invalid, failed or unpriced response; no retry');
    }
  } catch (e) { error = e instanceof Error ? e.message : String(e); process.exitCode = 1; }
  finally {
    await adapter.close(); await writeFile(join(root, 'manifest.json'), JSON.stringify({ ...plan, calls, estimatedUsd, unpricedCalls, error, status: error ? 'incomplete' : 'completed' }, null, 2));
    console.log(JSON.stringify({ root, calls, estimatedUsd, unpricedCalls, error }));
  }
}
