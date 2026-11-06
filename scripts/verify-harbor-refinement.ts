import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { caseInput, dialogueCasesSchema, sha256, validateProfilePair } from '../scripts/lib/dialogue-eval.js';
import { baseInstructions } from '../src/core/prompts.js';
import { dialoguePolicies } from '../src/core/dialogue-policies.js';
import { harborProfilePolicies } from '../src/shared/harbor-profiles.js';
import { exampleSpec } from '../src/shared/example.js';
import { experimentSchema } from '../src/shared/schema.js';
import type { DialoguePromptVersion } from '../src/shared/dialogue-policy.js';
const root = 'docs/reviews/harbor-refinement-2026-11-07';
const read = (file: string) => fs.readFileSync(path.join(root,file),'utf8');
const json = (file: string) => JSON.parse(read(file));
const jsonl = (file: string) => read(file).trim().split('\n').filter(Boolean).map(s=>JSON.parse(s));
const manifest=json('manifest.json');
const importable = experimentSchema.parse(JSON.parse(fs.readFileSync('examples/harbor-profile4.json', 'utf8')));
assert.equal(importable.scenario.id, 'fog-harbor-profile4');
assert.deepEqual(importable.scenario.characters, exampleSpec('mock-model', 'low', 'harbor-profile/4').scenario.characters);
assert.ok(importable.variants.every(v => v.dialoguePromptVersion === 'npc-dialogue/5'));
for(const f of manifest.files){const text=read(f.path);assert.equal(sha256(text),f.sha256,f.path);assert.equal(Buffer.byteLength(text),f.bytes);}
for (const [version, policy] of Object.entries(json('profile-policies.json'))) assert.deepEqual(policy, harborProfilePolicies[version as keyof typeof harborProfilePolicies]);
let fixed=0, conversation=0, quoted=0, verifiedLanguage=0;
for(const e of manifest.experiments){
  if(e.kind==='fixed'){
    const baseline=dialogueCasesSchema.parse(json(e.id+'/cases.json'));
    const hasCandidate=fs.existsSync(path.join(root,e.id,'candidate-cases.json'));
    const candidate=hasCandidate?dialogueCasesSchema.parse(json(e.id+'/candidate-cases.json')):baseline;
    const requests=jsonl(e.id+'/requests.jsonl'),samples=jsonl(e.id+'/samples.jsonl'),api=jsonl(e.id+'/api-requests.jsonl');
    assert.equal(requests.length,e.calls);assert.equal(samples.length,e.calls);assert.equal(api.length,e.calls);
    for(const r of requests){
      const source=(r.conditionId==='candidate'?candidate:baseline).cases.find(c=>c.id===r.caseId)!;
      const p=caseInput(source,r.version as DialoguePromptVersion,r.config.model,r.config.effort);
      const s=samples.find(s=>s.clientMessageId===r.clientMessageId)!;
      const body=api.find(a=>a.clientMessageId===r.clientMessageId)!.body;
      assert.equal(r.input,p.input);assert.equal(r.instructions,baseInstructions+'\n'+p.instructions);
      assert.equal(s.instructionsSha256,sha256(r.instructions));assert.equal(s.inputSha256,sha256(r.input));
      assert.equal(body.input,r.input);assert.equal(body.instructions,r.instructions);assert.equal(body.model,r.config.model);
      assert.equal(body.reasoning.effort,r.config.effort);assert.equal(body.previous_response_id,null);assert.equal(s.status,'completed');
      assert.equal(s.actualModel,r.config.model);assert.equal(s.conditionId,r.conditionId);assert.equal(s.model,r.config.model);assert.equal(s.effort,r.config.effort);
      fixed++;
    }
    for(const c of baseline.cases)validateProfilePair(c,candidate.cases.find(o=>o.id===c.id)!);
  }else{
    const [before, after] = json(e.id+'/configs.json');
    const common = (s: any) => ({...s, name:'<profile>', scenario:{...s.scenario,id:'<profile>',characters:s.scenario.characters.map((c: any)=>{
      const {goals, speechStyle, exampleDialogue, ...identity}=c; return c.id==='doha'?c:identity;
    })}});
    assert.deepEqual(common(before),common(after),e.id+' comparison conditions');
    for(const run of e.runs){
      const prefix=e.id+'/'+run.part;
      const calls=jsonl(prefix+'/calls.jsonl'),api=jsonl(prefix+'/api-requests.jsonl');
      const instructions=Object.values(json(prefix+'/instructions.json')) as any[];
      for(const s of instructions)assert.equal(sha256(s.instructions),s.sha256);
      for(const c of calls){
        const session=instructions.find(s=>s.sha256===c.metadata.instructionsSha256);assert.ok(session);
        const body=api.find(a=>a.clientMessageId===c.id)!.body;
        assert.equal(body.instructions,baseInstructions+'\n'+session.instructions);assert.equal(body.input,c.input);
        assert.equal(c.actualModel,c.model);assert.equal(body.model,c.model);assert.equal(body.reasoning.effort,c.effort);assert.equal(c.status,'completed');
        if(c.kind==='speech')assert.ok(session.instructions.includes(dialoguePolicies[c.metadata.dialoguePromptVersion as DialoguePromptVersion].instructions));
        conversation++;
      }
      const utterances=jsonl(prefix+'/utterances.jsonl'),speech=utterances.filter(u=>u.kind==='speech');
      const flags=speech.filter(u=>/[\u3040-\u30ff]/u.test(u.speech+u.action));
      assert.equal(speech.length,run.speechCount);assert.equal(flags.length,run.languageFlags.length);verifiedLanguage+=flags.length;
      assert.equal(run.status,'completed');assert.equal(run.completionReason,e.scene === 'lighthouse' ? 'goals_achieved' : 'utterance_limit');
    }
  }
}
for(const j of json('judgments.json').judgments){
  const samples=jsonl(j.experiment+'/samples.jsonl');
  for(const evidence of j.evidence){assert.equal(samples.find(s=>s.clientMessageId===evidence.clientMessageId)!.output,evidence.quote);quoted++;}
}
assert.equal(fixed+conversation,manifest.totals.calls);
let links=0;
for(const file of ['README.md','docs/dialogue-prompts.md',root+'/report.md'])for(const m of fs.readFileSync(file,'utf8').matchAll(/\]\(([^)]+)\)/g)){
  if(/^https?:|^#/.test(m[1]))continue;
  assert.ok(fs.existsSync(path.resolve(path.dirname(file),m[1].split('#')[0])),file+': '+m[1]);links++;
}
console.log(JSON.stringify({files:manifest.files.length,fixed,conversation,quoted,verifiedLanguage,links,status:'passed'}));
