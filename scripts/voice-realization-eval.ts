import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { OpenAIAdapter } from '../src/adapters/openai.js';
import { baseInstructions } from '../src/core/prompts.js';
import { getModelPricing, PRICING_REVISION } from '../src/shared/model-catalog.js';
import { dialogueCasesSchema, sha256 } from './lib/dialogue-eval.js';
import { loadVoiceProfile, withVoiceProfile } from './lib/voice-profiles.js';

const {values}=parseArgs({options:{source:{type:'string'},model:{type:'string',default:'gpt-6-luna'},live:{type:'boolean',default:false},
  profile:{type:'string',default:'seowol-profile/3'},prefix:{type:'string',default:'assumed_help_'},
  'max-calls':{type:'string',default:'10'},'max-usd':{type:'string',default:'1'}}});
if(!values.source)throw Error('--source is required');
const maxCalls=Number(values['max-calls']),maxUsd=Number(values['max-usd']);
if(!Number.isSafeInteger(maxCalls)||maxCalls<1||maxCalls>40||!Number.isFinite(maxUsd)||maxUsd<=0||maxUsd>2)throw Error('Invalid limits');
const source=resolve(values.source),rawCases=await readFile(join(source,'cases.json'),'utf8');
const suite=dialogueCasesSchema.parse(JSON.parse(rawCases));
const rawSamples=await readFile(join(source,'samples.jsonl'),'utf8');
const sourceSample=z.object({caseId:z.string(),repetition:z.number(),version:z.string(),status:z.string(),output:z.string(),instructionsSha256:z.string(),inputSha256:z.string()});
const samples=rawSamples.trim().split('\n').map(s=>sourceSample.parse(JSON.parse(s))).filter(s=>s.status==='completed'&&s.version===values.profile&&s.caseId.startsWith(values.prefix!));
if(!samples.length||samples.length>maxCalls)throw Error('Plan exceeds limits or has no source responses');
const rawPolicy=await readFile('evals/dialogue/voice-realization.json','utf8');
const policy=z.object({version:z.string(),instructions:z.string()}).parse(JSON.parse(rawPolicy)),profile=loadVoiceProfile(values.profile!);
const sourceProfiles=JSON.parse(await readFile(join(source,'profiles.json'),'utf8')) as {version:string;hashes:typeof profile.hashes}[];
const sourceProfile=sourceProfiles.find(p=>p.version===profile.version);
if(!sourceProfile||JSON.stringify(sourceProfile.hashes)!==JSON.stringify(profile.hashes))throw Error('Source profile changed after draft generation');
const speech=z.object({speech:z.string()}).strict(),outputSchema=z.toJSONSchema(speech);
const plan={version:policy.version,policySha256:sha256(rawPolicy),source:values.source,sourceSamplesSha256:sha256(rawSamples),casesSha256:sha256(rawCases),
  profile:profile.version,profileHashes:profile.hashes,model:values.model!,effort:'low',expectedCalls:samples.length,maxCalls,maxUsd,pricingRevision:PRICING_REVISION,
  scope:'Reuse already generated drafts; new paid calls edit only speech. Original action is preserved outside the model output.'};
if(!values.live)console.log(JSON.stringify({live:false,...plan},null,2));
else{
  const root=resolve('.cache/voice-realization',new Date().toISOString().replace(/[:.]/g,'-'));await mkdir(root,{recursive:true});
  await writeFile(join(root,'plan.json'),JSON.stringify(plan,null,2));await writeFile(join(root,'cases.json'),rawCases);await writeFile(join(root,'policy.json'),rawPolicy);
  await writeFile(join(root,'profile.json'),JSON.stringify(profile,null,2));await writeFile(join(root,'source-samples.jsonl'),rawSamples);
  const adapter=new OpenAIAdapter(join(root,'runtime'),{maxOutputTokens:2048});let calls=0,estimatedUsd=0,unpricedCalls=0,error:string|null=null;
  console.log(JSON.stringify({root,...plan}));
  try{
    const models=await adapter.models();if(!models.some(m=>m.id===plan.model&&m.efforts.includes(plan.effort)))throw Error('Unavailable model');
    for(const s of samples){
      if(calls>=maxCalls||estimatedUsd>=maxUsd)throw Error('Budget reached');
      const c=suite.cases.find(c=>c.id===s.caseId)!;if(!c)throw Error('Missing source case');
      const actor=withVoiceProfile(c.characters.find(a=>a.id===c.speakerId)!,profile);
      const draft=z.object({speech:z.string(),action:z.string()}).parse(JSON.parse(s.output));
      const input=JSON.stringify({speaker:actor.name,personality:actor.personality,relationships:actor.relationships,speechStyle:actor.speechStyle,
        examples:actor.exampleDialogue,observedDialogue:c.history.map(h=>({speaker:c.characters.find(a=>a.id===h.speakerId)!.name,speech:h.speech})),draft:draft.speech});
      const threadId=await adapter.createSession(plan,policy.instructions,root),clientMessageId=randomUUID();
      await appendFile(join(root,'requests.jsonl'),JSON.stringify({caseId:c.id,repetition:s.repetition,clientMessageId,instructions:baseInstructions+'\n'+policy.instructions,input,outputSchema})+'\n');
      calls++;const started=performance.now();const result=await adapter.turn({threadId,config:plan,input,outputSchema,clientMessageId,timeoutMs:90_000},()=>{});
      const u=result.usage,p=getModelPricing(result.actualModel??plan.model);
      const rate=p&&u?.inputTokens!=null&&p.longContext&&u.inputTokens>p.longContext.aboveInputTokens?p.longContext:p;
      const cost=rate&&u?.inputTokens!=null&&u.outputTokens!=null?((u.inputTokens-(u.cachedInputTokens??0))*rate.input+(u.cachedInputTokens??0)*rate.cached+u.outputTokens*rate.output)/1_000_000:null;
      let parsed:{speech:string}|null=null;try{parsed=speech.parse(JSON.parse(result.output));}catch{/* preserve raw */}
      const valid=result.status==='completed'&&parsed!==null;
      await appendFile(join(root,'samples.jsonl'),JSON.stringify({caseId:c.id,repetition:s.repetition,clientMessageId,status:result.status,valid,draft,
        output:result.output,publicOutput:parsed?{speech:parsed.speech,action:draft.action}:null,usage:u,actualModel:result.actualModel,costUsd:cost,
        durationMs:performance.now()-started,error:result.error??null,inputSha256:sha256(input),instructionsSha256:sha256(baseInstructions+'\n'+policy.instructions)})+'\n');
      if(cost!==null)estimatedUsd+=cost;else unpricedCalls++;
      console.log(JSON.stringify({caseId:c.id,repetition:s.repetition,calls,valid}));if(!valid||cost===null)throw Error('Invalid, failed or unpriced response; no retry');
    }
  }catch(e){error=e instanceof Error?e.message:String(e);process.exitCode=1;}
  finally{await adapter.close();await writeFile(join(root,'manifest.json'),JSON.stringify({...plan,calls,estimatedUsd,unpricedCalls,error,status:error?'incomplete':'completed'},null,2));console.log(JSON.stringify({root,calls,estimatedUsd,unpricedCalls,error}));}
}
