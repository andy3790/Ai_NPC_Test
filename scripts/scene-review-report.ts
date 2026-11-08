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
const prefixArg=process.argv.slice(4).find(a=>a.startsWith('--through='));
const through=prefixArg ? Number(prefixArg.slice('--through='.length)) : undefined;
if (through!==undefined && (!Number.isSafeInteger(through) || through<1)) throw Error('--through requires a positive number of choices.');
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
function longRestOutcomes(choices:Utterance[], calls:InvocationMetrics[]) {
  const byUtterance=new Map(calls.filter(c=>c.status==='completed' && c.utteranceId).map(c=>[c.utteranceId,c]));
  const nextAt=new Map<string,number>(); let elapsed=0,interrupted=0,noNextTurn=0;
  for (const u of [...choices].reverse()) {
    const at=u.sceneSeconds ?? u.perception?.virtualSeconds,call=byUtterance.get(u.id);
    if (at===undefined || !call) continue;
    const wait=JSON.parse(call.output).waitSeconds;
    if (typeof wait==='number' && wait>=120) {
      const next=nextAt.get(u.speakerId);
      if (next===undefined) noNextTurn++;
      else if (next-at+1e-6>=wait) elapsed++;
      else interrupted++;
    }
    nextAt.set(u.speakerId,at);
  }
  return {elapsed,interrupted,noNextTurn};
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
    let matchedChoices;
    if (through!==undefined) {
      if (choices.length<through) throw Error('Not enough committed choices for --through in '+label);
      const prefix=choices.slice(0,through), ids=new Set(prefix.map(t=>t.id));
      const keys=new Set(speech.filter(c=>c.utteranceId && ids.has(c.utteranceId)).map(c=>c.operationKey));
      const last=prefix.at(-1)!;
      matchedChoices={through,clockAtChoice:last.perception?.virtualSeconds ?? last.sceneSeconds ?? null,
        npc:metrics(speech.filter(c=>keys.has(c.operationKey)))};
    }
    const memories = r.conversationMemoryVersion ? speech.filter(c => c.status==='completed' && c.utteranceId).map(c => {
      const memory=JSON.parse(c.input).conversationMemory;
      const offers=c.metadata.memoryOffers;
      return {checkpoint:Array.isArray(offers), selected:Array.isArray(offers) && offers.includes(JSON.parse(c.output).setAsideSequence),
        compacted:Number(c.metadata.omittedRecall)>0, retrieved:!!memory?.setAside?.length, quiet:!!memory?.quiet,
        goal:!!memory?.lastGoalObservation, prospective:!!memory?.prospective};
    }) : [];
    const { matches:_privateLinks,...repeatCounts }=repetition;
    const parties = r.spec.scenario.characters.map(c => ({name:c.name,choices:choices.filter(t => t.speakerId===c.id).length,
      spoken:choices.filter(t => t.speakerId===c.id && t.speech.trim()).length}));
    const kinds = [...new Set(calls.map(c => c.kind))];
    const flowDecisions=speech.filter(c=>c.status==='completed' && c.utteranceId && c.metadata.sceneFlowVersion).map(c=>JSON.parse(c.output));
    const cuts=u.flatMap(t=>t.timeCut ? [t.timeCut] : []);
    const sampleSize = Math.min(8,Math.floor(speech.length/2));
    const repairs = db.prepare("SELECT COUNT(*) AS count FROM events WHERE method='run/repairing_output'").get();
    runs.push({label,scenario:r.spec.scenario.name,sceneRevision:r.spec.scenario.id,status:r.status,completionReason:r.completionReason ?? null,limit:r.spec.maxUtterances,
      choices:choices.length,spoken:choices.filter(t => t.speech.trim()).length,actionOnly:choices.filter(t => !t.speech.trim() && t.action.trim()).length,
      silentWaits:choices.filter(t => !t.speech.trim() && !t.action.trim() && !t.actionId && !t.spatialIntent?.moveToLocationId && t.spatialIntent?.activityChoice!=='cancel').length,
      voices:parties,events:u.length-choices.length,virtualSeconds:r.worldState?.virtualSeconds ?? r.sceneSeconds ?? null,
      authoredEvents:r.worldState?.firedClockEvents ?? [],facts:facts.map(f => f.text),processes:processes.map(p => ({description:p.description,status:p.status})),
      positions:r.worldState?.spatial?.positions.map(p => ({npc:p.npcId,place:p.locationId,transit:p.transit?.connectionId ?? null})),
      proposals:r.eventGeneratorState?.proposals.map(p => ({title:p.title,at:p.virtualSeconds,status:p.status,...(p.causeSequence && {causeSequence:p.causeSequence})})),
      ...(r.sceneFlowVersion && {sceneFlow:{version:r.sceneFlowVersion,choices:flowDecisions.length,longRests:longRestOutcomes(choices,speech),
        adoptedIntentions:flowDecisions.filter(d=>d.followThrough).length,explicitWaits:flowDecisions.filter(d=>d.waitSeconds>0).length,
        cuts:cuts.length,skippedSeconds:cuts.reduce((sum,c)=>sum+c.to-c.from,0)}}),
      prompt:r.promptVersion,actorContext:r.npcContextVersion ?? 'provider-chain',worldContext:r.worldContextVersion ?? null,
      ...(r.sceneObservationVersion && {sceneObservation:r.sceneObservationVersion,topicClosure:r.topicClosureVersion}),
      ...(r.socialReactionVersion && {socialReaction:r.socialReactionVersion,
        socialChoicesOffered:speech.filter(c=>c.utteranceId && c.status==='completed' && c.metadata.socialReactionVersion).length,
        focusedReactions:speech.filter(c=>c.utteranceId && c.status==='completed' && c.metadata.socialBeat).length}),
      ...(r.conversationMemoryVersion && {conversationMemory:{version:r.conversationMemoryVersion,
        checkpoints:memories.filter(m=>m.checkpoint).length, selections:memories.filter(m=>m.selected).length,
        compacted:memories.filter(m=>m.compacted).length, reintroduced:memories.filter(m=>m.retrieved).length,
        quiet:memories.filter(m=>m.quiet).length, goalObservations:memories.filter(m=>m.goal).length,
        prospective:memories.filter(m=>m.prospective).length}}),
      dialogue:r.variant.dialoguePromptVersion,performance:r.variant.characterPerformanceVersion,world:r.variant.worldPromptVersion ?? null,
      ...(r.sparseVoiceVersion && {sparseVoice:{version:r.sparseVoiceVersion,
        followUps:speech.filter(c => c.status==='completed' && c.utteranceId && c.metadata.sparseVoiceVersion).length}}),
      worldContracts:[...new Set(calls.filter(c => c.kind==='environment').map(c => c.metadata.worldContractVersion ?? 'static'))],
      spatialChoices:[...new Set(speech.flatMap(c => c.metadata.spatialChoiceVersion ? [c.metadata.spatialChoiceVersion] : []))],
      languageChecks:[...new Set(speech.flatMap(c => c.metadata.languageCheckVersion ? [c.metadata.languageCheckVersion] :
        r.npcContextVersion && r.npcContextVersion!=='npc-context/1' ? ['npc-language/1'] : []))],
      constrainedLanguageRepairs:speech.filter(c => c.metadata.languageRepair === true).length,
      models:[...new Set(calls.map(c => c.model+'/'+c.effort))],actualModels:[...new Set(calls.map(c => c.actualModel).filter(Boolean))],
      automaticRepairCycles:Number(repairs?.count ?? 0),specSha256:createHash('sha256').update(JSON.stringify(r.spec)).digest('hex'),
      ...metrics(calls),...(matchedChoices && {matchedChoices}),activeMs:Math.round(r.activeMs),roles:Object.fromEntries(kinds.map(k => [k,metrics(calls.filter(c => c.kind===k))])),
      inputWindow:{calls:sampleSize,firstSpeechInputs:speech.slice(0,sampleSize).map(c => c.usage.inputTokens),lastSpeechInputs:speech.slice(-sampleSize).map(c => c.usage.inputTokens)},
      repetitions:repeatCounts,kanaLines:choices.filter(c => /[\u3041-\u3096\u30a1-\u30fa]/u.test(c.speech+' '+c.action)).length,
      errorKinds:calls.filter(c => c.status==='failed').map(c => ({kind:c.kind,attempt:c.attempt,phase:c.metadata.phase ?? null})),
    });
    for (const t of u) transcript.push(JSON.stringify({run:label,sequence:t.sequence,turn:t.speechIndex,at:t.perception?.virtualSeconds ?? t.worldEvent?.virtualSeconds ?? t.sceneSeconds ?? null,
      speaker:t.speakerName,kind:t.kind,speech:t.speech,action:t.action,...(t.worldEvent && {event:t.worldEvent.type}),
      ...(t.timeCut && {timeCut:t.timeCut}),
      ...(t.perception && {place:t.perception.locationId,heardBy:t.perception.speechRecipientIds,sawAction:t.perception.actionRecipientIds})}));
  } finally {db.close();}
}
const budget = new DatabaseSync(reviewBudgetFile(root),{readOnly:true});
const ledger=budget.prepare('SELECT COUNT(*) AS requests, COUNT(response) AS settled, SUM(charge) AS conservativeUsd FROM requests').get();
budget.close();
await writeFile(join(output,'usage.json'),JSON.stringify({pricingDate:PRICING_DATE,pricingRevision:PRICING_REVISION,ledger,runs},null,2)+'\n');
await writeFile(join(output,'transcript.jsonl'),transcript.join('\n')+'\n');
