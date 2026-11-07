import { createHash } from 'node:crypto';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { aggregate } from '../src/core/metrics.js';
import { repetitionMetrics } from '../src/core/quality.js';
import { reviewBudgetFile } from './review-budget.js';
import type { InvocationMetrics, Run, Utterance } from '../src/shared/types.js';
import { PRICING_DATE, PRICING_REVISION } from '../src/shared/model-catalog.js';

const [group, output] = process.argv.slice(2);
if (!group || !/^[\w-]+$/.test(group) || !output) throw Error('Provide a review group and an output directory.');
const root = resolve('.cache','scene-review',group);
await mkdir(output,{recursive:true});
const runs = [], transcript: string[] = [];
function percentile(samples: (number|null)[], q: number) {
  const sorted = samples.filter((n):n is number => n !== null).sort((a,b) => a-b);
  return sorted.length ? Math.round(sorted[Math.ceil(sorted.length*q)-1]) : null;
}
function metrics(calls: InvocationMetrics[]) {
  const a = aggregate(calls,'openai');
  return {requests:a.calls,failed:a.failed,missingUsage:a.missingUsage,unpriced:a.cost.unpricedCalls,
    usd:a.cost.usd,tokens:a.tokens,medianMs:a.medianMs,p95Ms:a.p95Ms,
    firstOutputMedianMs:percentile(calls.map(c => c.firstOutputMs),.5),firstOutputP95Ms:percentile(calls.map(c => c.firstOutputMs),.95)};
}
for (const dir of (await readdir(root,{withFileTypes:true})).filter(d => d.isDirectory() && d.name !== 'runtime').sort((a,b) => a.name.localeCompare(b.name))) {
  const label = dir.name, db = new DatabaseSync(join(root,label,'npc-lab.sqlite'),{readOnly:true});
  try {
    const records = <T>(table:'runs'|'utterances'|'invocations'):T[] => db.prepare('SELECT data FROM '+table+' ORDER BY rowid').all().map(r => JSON.parse(String(r.data)));
    const [r] = records<Run>('runs'); if (!r) continue;
    if (!['completed','paused','stopped'].includes(r.status)) {
      if (process.argv.includes('--completed-only')) continue;
      throw Error('Review still active: '+label);
    }
    const u = records<Utterance>('utterances'), calls = records<InvocationMetrics>('invocations');
    const choices=u.filter(t => t.kind === 'speech'), facts=r.worldState?.facts ?? [], processes=r.worldState?.processes ?? [];
    const speech=calls.filter(c => c.kind === 'speech'), repetition=repetitionMetrics(r.spec,u);
    const { matches:_privateLinks,...repeatCounts }=repetition;
    const parties = r.spec.scenario.characters.map(c => ({name:c.name,choices:choices.filter(t => t.speakerId===c.id).length,
      spoken:choices.filter(t => t.speakerId===c.id && t.speech.trim()).length}));
    const kinds = [...new Set(calls.map(c => c.kind))];
    const sampleSize = Math.min(8,Math.floor(speech.length/2));
    const repairs = db.prepare("SELECT COUNT(*) AS count FROM events WHERE method='run/repairing_output'").get();
    runs.push({label,scenario:r.spec.scenario.name,sceneRevision:r.spec.scenario.id,status:r.status,completionReason:r.completionReason ?? null,limit:r.spec.maxUtterances,
      choices:choices.length,spoken:choices.filter(t => t.speech.trim()).length,actionOnly:choices.filter(t => !t.speech.trim() && t.action.trim()).length,
      silentWaits:choices.filter(t => !t.speech.trim() && !t.action.trim() && !t.actionId && !t.spatialIntent?.moveToLocationId && t.spatialIntent?.activityChoice!=='cancel').length,
      voices:parties,events:u.length-choices.length,virtualSeconds:r.worldState?.virtualSeconds ?? null,
      authoredEvents:r.worldState?.firedClockEvents ?? [],facts:facts.map(f => f.text),processes:processes.map(p => ({description:p.description,status:p.status})),
      positions:r.worldState?.spatial?.positions.map(p => ({npc:p.npcId,place:p.locationId,transit:p.transit?.connectionId ?? null})),
      proposals:r.eventGeneratorState?.proposals.map(p => ({title:p.title,at:p.virtualSeconds,status:p.status})),
      prompt:r.promptVersion,actorContext:r.npcContextVersion ?? 'provider-chain',worldContext:r.worldContextVersion ?? null,
      dialogue:r.variant.dialoguePromptVersion,performance:r.variant.characterPerformanceVersion,world:r.variant.worldPromptVersion ?? null,
      worldContracts:[...new Set(calls.filter(c => c.kind==='environment').map(c => c.metadata.worldContractVersion ?? 'static'))],
      spatialChoices:[...new Set(speech.flatMap(c => c.metadata.spatialChoiceVersion ? [c.metadata.spatialChoiceVersion] : []))],
      languageChecks:[...new Set(speech.flatMap(c => c.metadata.languageCheckVersion ? [c.metadata.languageCheckVersion] :
        r.npcContextVersion && r.npcContextVersion!=='npc-context/1' ? ['npc-language/1'] : []))],
      constrainedLanguageRepairs:speech.filter(c => c.metadata.languageRepair === true).length,
      models:[...new Set(calls.map(c => c.model+'/'+c.effort))],actualModels:[...new Set(calls.map(c => c.actualModel).filter(Boolean))],
      automaticRepairCycles:Number(repairs?.count ?? 0),specSha256:createHash('sha256').update(JSON.stringify(r.spec)).digest('hex'),
      ...metrics(calls),activeMs:Math.round(r.activeMs),roles:Object.fromEntries(kinds.map(k => [k,metrics(calls.filter(c => c.kind===k))])),
      inputWindow:{calls:sampleSize,firstSpeechInputs:speech.slice(0,sampleSize).map(c => c.usage.inputTokens),lastSpeechInputs:speech.slice(-sampleSize).map(c => c.usage.inputTokens)},
      repetitions:repeatCounts,kanaLines:choices.filter(c => /[\u3041-\u3096\u30a1-\u30fa]/u.test(c.speech+' '+c.action)).length,
      errorKinds:calls.filter(c => c.status==='failed').map(c => ({kind:c.kind,attempt:c.attempt,phase:c.metadata.phase ?? null})),
    });
    for (const t of u) transcript.push(JSON.stringify({run:label,sequence:t.sequence,turn:t.speechIndex,at:t.perception?.virtualSeconds ?? t.worldEvent?.virtualSeconds ?? null,
      speaker:t.speakerName,kind:t.kind,speech:t.speech,action:t.action,...(t.worldEvent && {event:t.worldEvent.type}),
      ...(t.perception && {place:t.perception.locationId,heardBy:t.perception.speechRecipientIds,sawAction:t.perception.actionRecipientIds})}));
  } finally {db.close();}
}
const budget = new DatabaseSync(reviewBudgetFile(root),{readOnly:true});
const ledger=budget.prepare('SELECT COUNT(*) AS requests, COUNT(response) AS settled, SUM(charge) AS conservativeUsd FROM requests').get();
budget.close();
await writeFile(join(output,'usage.json'),JSON.stringify({pricingDate:PRICING_DATE,pricingRevision:PRICING_REVISION,ledger,runs},null,2)+'\n');
await writeFile(join(output,'transcript.jsonl'),transcript.join('\n')+'\n');
