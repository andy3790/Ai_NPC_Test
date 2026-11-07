import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { OpenAIAdapter } from '../src/adapters/openai.js';
import { outputSchemas, speechSchema } from '../src/shared/schema.js';
import { getModelPricing, PRICING_REVISION } from '../src/shared/model-catalog.js';
import { baseInstructions, PROMPT_VERSION } from '../src/core/prompts.js';
import { caseInput, dialogueCasesSchema, renderReview, sha256, type ReviewSample } from './lib/dialogue-eval.js';
import { loadVoiceProfile, withVoiceProfile } from './lib/voice-profiles.js';

const { values } = parseArgs({ options: { live: { type: 'boolean', default: false },
  cases: { type: 'string', default: 'evals/dialogue/voice-transfer.json' }, split: { type: 'string', default: 'all' },
  baseline: { type: 'string', default: 'seowol-profile/1' }, candidate: { type: 'string', default: 'seowol-profile/2' },
  model: { type: 'string', default: 'gpt-6-luna' }, effort: { type: 'string', default: 'low' },
  repetitions: { type: 'string', default: '2' }, 'max-calls': { type: 'string', default: '48' }, 'max-usd': { type: 'string', default: '1' },
} });
const repetitions = Number(values.repetitions), maxCalls = Number(values['max-calls']), maxUsd = Number(values['max-usd']);
if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 3 || !Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 160 ||
  !Number.isFinite(maxUsd) || maxUsd <= 0 || maxUsd > 3 || !['development', 'holdout', 'all'].includes(values.split!) || values.baseline === values.candidate) throw Error('Invalid evaluation options');
const profiles = [loadVoiceProfile(values.baseline!), loadVoiceProfile(values.candidate!)];
const raw = await readFile(resolve(values.cases!), 'utf8'), suite = dialogueCasesSchema.parse(JSON.parse(raw));
const cases = suite.cases.filter(c => values.split === 'all' || c.split === values.split);
const plan = { suiteVersion: suite.version, casesSha256: sha256(raw), profileVersions: profiles.map(p=>p.version),
  dialoguePromptVersion: 'npc-dialogue/5' as const, promptVersion: PROMPT_VERSION, model: values.model!, effort: values.effort!,
  repetitions, split: values.split, expectedCalls: cases.length * repetitions * 2, maxCalls, maxUsd,
  pricingRevision: PRICING_REVISION, costLimit: 'Recorded catalogue estimate; one in-flight response may exceed it. No retry.' };
if (!cases.length || plan.expectedCalls > maxCalls) throw Error('Plan exceeds call limit');
// Validate both transformations and the same observed input before any API access.
for (const c of cases) {
  const inputs = profiles.map(profile => caseInput({ ...c, characters: c.characters.map(a=>a.id===c.speakerId ? withVoiceProfile(a,profile) : a) },
    plan.dialoguePromptVersion, plan.model, plan.effort).input);
  if (inputs[0] !== inputs[1]) throw Error('Profile comparison changed the observed input');
}
if (!values.live) console.log(JSON.stringify({ live: false, ...plan }, null, 2));
else {
  const root = resolve('.cache/profile-eval', new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0,8));
  await mkdir(root,{recursive:true}); await writeFile(join(root,'cases.json'),raw);
  await writeFile(join(root,'profiles.json'),JSON.stringify(profiles,null,2)); await writeFile(join(root,'plan.json'),JSON.stringify(plan,null,2));
  const adapter = new OpenAIAdapter(join(root,'runtime'), {maxOutputTokens:2048});
  const samples: (ReviewSample & Record<string,unknown>)[] = [];
  let calls=0, estimatedUsd=0, unpricedCalls=0, error: string|null=null;
  console.log(JSON.stringify({root,...plan}));
  try {
    const models = await adapter.models(); if (!models.some(m=>m.id===plan.model && m.efforts.includes(plan.effort))) throw Error('Unavailable model');
    for (const [index,c] of cases.entries()) for (let repetition=1; repetition<=repetitions; repetition++) {
      for (const [slotIndex,profile] of ((index+repetition)%2 ? [...profiles].reverse() : profiles).entries()) {
        if (calls>=maxCalls || estimatedUsd>=maxUsd) throw Error('Budget reached');
        const transformed = {...c,characters:c.characters.map(a=>a.id===c.speakerId ? withVoiceProfile(a,profile) : a)};
        const p = caseInput(transformed,plan.dialoguePromptVersion,plan.model,plan.effort), clientMessageId=randomUUID();
        const threadId=await adapter.createSession(plan,p.instructions,root);
        await appendFile(join(root,'requests.jsonl'),JSON.stringify({caseId:c.id,repetition,version:profile.version,clientMessageId,
          ...p,instructions:baseInstructions+'\n'+p.instructions,outputSchema:outputSchemas.speech})+'\n');
        const start=performance.now(); calls++;
        const result=await adapter.turn({threadId,config:plan,input:p.input,outputSchema:outputSchemas.speech,clientMessageId,timeoutMs:90_000},()=>{});
        const u=result.usage, price=getModelPricing(result.actualModel??plan.model);
        const rate=price&&u?.inputTokens!=null&&price.longContext&&u.inputTokens>price.longContext.aboveInputTokens?price.longContext:price;
        const cost=rate&&u?.inputTokens!=null&&u.outputTokens!=null?((u.inputTokens-(u.cachedInputTokens??0))*rate.input+(u.cachedInputTokens??0)*rate.cached+u.outputTokens*rate.output)/1_000_000:null;
        let valid=false; try {valid=result.status==='completed'&&speechSchema.safeParse(JSON.parse(result.output)).success;} catch { /* preserve raw */ }
        const sample={caseId:c.id,repetition,slot:slotIndex?'B':'A',version:profile.version,clientMessageId,status:valid?'completed':result.status==='completed'?'invalid_output':result.status,
          output:result.output,actualModel:result.actualModel,usage:u,costUsd:cost,durationMs:performance.now()-start,error:result.error??null,
          instructionsSha256:p.instructionsSha256,inputSha256:p.inputSha256};
        samples.push(sample); await appendFile(join(root,'samples.jsonl'),JSON.stringify(sample)+'\n');
        if(cost!==null)estimatedUsd+=cost;else unpricedCalls++;
        console.log(JSON.stringify({caseId:c.id,repetition,slot:sample.slot,calls,valid}));
        if(!valid||cost===null)throw Error('Failed, invalid or unpriced response; no retry');
      }
    }
  } catch(e) {error=e instanceof Error?e.message:String(e);process.exitCode=1;}
  finally {
    await adapter.close(); await writeFile(join(root,'review.md'),renderReview(cases,samples));
    await writeFile(join(root,'manifest.json'),JSON.stringify({...plan,status:error?'incomplete':'completed',calls,estimatedUsd,unpricedCalls,error,
      mappings:samples.map(s=>({caseId:s.caseId,repetition:s.repetition,slot:s.slot,version:s.version}))},null,2));
    console.log(JSON.stringify({root,calls,estimatedUsd,unpricedCalls,error}));
  }
}
