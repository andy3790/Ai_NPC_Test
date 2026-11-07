import { randomUUID, createHash } from 'node:crypto';
import { spatialSpeechSchema } from '../shared/spatial-schema.js';
import type { Utterance } from '../shared/types.js';
import type { SimulationHost } from './simulation-host.js';
import { audienceNpcIds, localContext } from './perception.js';
import { publicMessage, speakerPrompt } from './prompts.js';
import { applySpatialPlan, applySpatialResolution, closePassages, commitSpatialChoice, dueActivities, dueProcesses, initialSpatialWorld, nextSpatialTime, selectableGroups, validateSpatialChoice } from './spatial-state.js';
import { clockObservations, nextClockBoundary } from './scene-clock.js';
import { managerState, managerWorld, spatialPlannerInstructions, spatialResolverInstructions } from './spatial-prompts.js';
import { decideSituation, generateSituation, nextSituationCheck, pendingProposal } from './situations.js';
import { directorObservations, directorPrompt } from './director.js';

const now = () => new Date().toISOString();
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
const state = (h: SimulationHost) => h.run().worldState!;
const history = (h: SimulationHost) => h.store.list('utterances', h.id);
function saveState(h: SimulationHost, next: ReturnType<typeof state>, method: string, invocationId: string | null = null) {
  h.store.patch('runs', h.id, { worldState: next });
  h.store.event(h.id, invocationId, method, { state: next });
}

async function prepareCycle(h: SimulationHost, remaining: number) {
  const run = h.run(), current = state(h), all = history(h);
  const groups = selectableGroups(run.spec, current, all).slice(0, remaining);
  if (!groups.length) return false;
  const npcIds: string[] = [];
  for (const group of groups) {
    let selected = group.ids[0];
    if (!group.urgent && run.variant.turnPolicy === 'director' && group.ids.length > 1) {
      const localHistory = all.filter(u => u.kind === 'speech' && (u.perception?.locationId === group.key || group.ids.includes(u.speakerId)));
      const age = (id: string) => localHistory.length - localHistory.findLastIndex(u => u.speakerId === id);
      const ordered = [...group.ids].sort((a, b) => age(b) - age(a));
      const allowed = age(ordered[0]) >= run.spec.scenario.characters.length * 2 ? [ordered[0]] : ordered.filter(id => id !== localHistory.at(-1)?.speakerId);
      if (allowed.length === 1) selected = allowed[0];
      else {
        const call = await h.direct(`spatial-director-${createHash('sha256').update(group.key).digest('hex').slice(0, 16)}`,
          `spatial:director:${current.spatial!.nextCycle}:${group.key}`, directorPrompt({
            characters: run.spec.scenario.characters.filter(c => group.ids.includes(c.id)), allowedSpeakerIds: allowed,
            location: group.key, history: directorObservations(all, group.ids), speeches: localHistory,
          }));
        selected = JSON.parse(call.output).speakerId;
        if (!allowed.includes(selected)) {
          h.store.patch('invocations', call.id, { status: 'failed', error: '허용되지 않은 공간별 선택자' });
          throw new Error('공간 진행자가 허용되지 않은 NPC를 선택했습니다.');
        }
      }
    }
    npcIds.push(selected);
  }
  const next = structuredClone(current);
  next.spatial!.cycle = { id: next.spatial!.nextCycle++, atSeconds: next.virtualSeconds, stage: 'deciding', npcIds, utteranceIds: [] };
  h.store.transaction(() => saveState(h, next, 'spatial/cycle_started')); h.changed(); return true;
}

async function decideCycle(h: SimulationHost) {
  const current = state(h), cycle = current.spatial!.cycle!, run = h.run(), all = history(h);
  const results = await Promise.allSettled(cycle.npcIds.map(async npcId => {
    const session = run.sessions[npcId];
    const pending = h.store.list('receipts', h.id).filter(r => r.characterId === npcId && r.status !== 'delivered');
    const messages = all.filter(u => pending.some(r => r.utteranceId === u.id));
    const known = new Set([...all.filter(u => u.speakerId === npcId).map(u => u.id),
      ...h.store.list('receipts', h.id).filter(r => r.characterId === npcId && r.status === 'delivered').map(r => r.utteranceId), ...messages.map(u => u.id)]);
    const call = await h.speak(session, `spatial:choice:${cycle.id}:${npcId}`,
      speakerPrompt(messages, run.variant.memoryMode === 'reinject_on_speech' ? session.instructions : undefined, undefined, npcId, localContext(run.spec, current, npcId)),
      { outputType: 'spatialSpeech', spatialChoiceVersion:'spatial-choice/2', receiptIds: pending.map(r => r.id), virtualSeconds: current.virtualSeconds }, all);
    try {
      const output = spatialSpeechSchema.parse(JSON.parse(call.output));
      const perception = validateSpatialChoice(run.spec, current, npcId, output);
      return { npcId, call, output, perception, pending, messages, known: [...known] };
    } catch (e) { h.store.patch('invocations', call.id, { status: 'failed', error: errorText(e) }); throw e; }
  }));
  const failed = results.find(r => r.status === 'rejected'); if (failed?.status === 'rejected') throw failed.reason;
  if (h.run().status === 'stopped') return;
  const ready = results.flatMap(r => r.status === 'fulfilled' ? [r.value] : []);
  h.store.transaction(() => {
    let next = structuredClone(current), sequence = all.length, count = all.filter(u => u.kind === 'speech').length;
    const ids: string[] = [];
    for (const d of ready) {
      const u: Utterance = { id: randomUUID(), runId: h.id, sequence: ++sequence, speechIndex: ++count, speakerId: d.npcId,
        speakerName: run.spec.scenario.characters.find(c => c.id === d.npcId)!.name, kind: 'speech', speech: d.output.speech, action: d.output.action,
        createdAt: now(), invocationId: d.call.id, deliveryCompletedAt: null, deliveryMs: null,
        perception: d.perception, spatialIntent: d.output, knownUtteranceIds: d.known };
      h.append(u); ids.push(u.id); next = commitSpatialChoice(next, u);
      for (const c of h.store.attempts(h.id, d.call.operationKey)) h.store.patch('invocations', c.id, { utteranceId: u.id });
      for (const r of d.pending) h.store.patch('receipts', r.id, { status: 'delivered', invocationId: d.call.id, deliveredAt: now() });
      for (const message of d.messages) h.completeDelivery(message);
    }
    next.spatial!.cycle = { ...cycle, stage: 'planning', utteranceIds: ids };
    next.spatial!.lastSelectedNpcIds = [...cycle.npcIds];
    const step = h.run().stepRemaining;
    h.store.patch('runs', h.id, { stepRemaining: step === null ? null : Math.max(0, step - ready.length), lastSpeakerId: ready.at(-1)?.npcId ?? run.lastSpeakerId });
    saveState(h, next, 'spatial/choices_committed');
  }); h.changed();
}

async function planCycle(h: SimulationHost) {
  const run = h.run(), current = state(h), cycle = current.spatial!.cycle!, all = history(h);
  const choices = cycle.utteranceIds.map(id => all.find(u => u.id === id)!);
  const spoken = choices.filter(u => !u.action.trim() && !u.spatialIntent?.moveToLocationId);
  const durations = spoken.map(u => ({ utteranceId:u.id, speechSeconds:u.speech.trim() ? Math.max(0.5, u.speech.replace(/\s/gu,'').length / 5.5) : 0,
    actionSeconds:u.speech.trim() ? 0 : 1, reactionNpcIds:[], movementStarts:false }));
  const physical = choices.filter(u => !spoken.includes(u));
  if (!physical.length) {
    const next = applySpatialPlan(run.spec,current,choices,{ plans:durations });
    h.store.transaction(() => saveState(h,next,'spatial/planned')); h.changed(); return;
  }
  const session = await h.helper('spatial-time-planner', run.spec.worldEngine!, spatialPlannerInstructions);
  const call = await h.invoke('environment', session, `spatial:plan:${cycle.id}`, JSON.stringify({ task: 'spatial_plan', ...managerWorld(run.spec),
    current: managerState(current, all, run.spec), choices:physical }), { outputType: 'spatialPlan', phase: 'plan', sourceUtteranceIds: physical.map(u => u.id), virtualSeconds: current.virtualSeconds }, all);
  let next: typeof current;
  try { next = applySpatialPlan(run.spec, current, choices, { plans:[...JSON.parse(call.output).plans,...durations] }); }
  catch (e) { h.store.patch('invocations', call.id, { status: 'failed', error: errorText(e) }); throw e; }
  if (h.run().status !== 'running') return;
  h.store.transaction(() => saveState(h, next, 'spatial/planned', call.id)); h.changed();
}

function scheduleResolution(h: SimulationHost, withProposal = false) {
  const next = structuredClone(state(h)); const proposal = withProposal ? pendingProposal(h) : undefined;
  next.spatial!.pendingResolution = { id: next.spatial!.nextResolution++, atSeconds: next.virtualSeconds, proposalId: proposal?.id ?? null };
  h.store.transaction(() => saveState(h, next, 'spatial/resolution_started'));
}
async function resolveWorld(h: SimulationHost) {
  const run = h.run(), current = state(h), checkpoint = current.spatial!.pendingResolution!, all = history(h);
  const proposal = run.eventGeneratorState?.proposals.find(p => p.id === checkpoint.proposalId);
  const due = dueActivities(current);
  if (!proposal && !dueProcesses(current).length && due.length && due.every(a => {
    const choice = all.find(u => u.id === a.sourceUtteranceId); return choice && !choice.action.trim() && !choice.spatialIntent?.moveToLocationId;
  }) && current.virtualSeconds - (current.spatial!.lastWorldCheckAt ?? -Infinity) < 15) {
    const next = structuredClone(current);
    for (const a of next.spatial!.activities) if (due.some(d => d.id === a.id)) Object.assign(a,{status:'completed',finishedAtSeconds:current.virtualSeconds,reason:'발화 종료'});
    next.spatial!.pendingResolution = null;
    h.store.transaction(() => saveState(h,next,'spatial/speech_finished')); h.changed(); return;
  }
  const session = await h.helper('spatial-world-resolver', run.spec.worldEngine!, spatialResolverInstructions);
  const call = await h.invoke('environment', session, `spatial:resolve:${checkpoint.id}`, JSON.stringify({ task: 'spatial_resolve', ...managerWorld(run.spec),
    currentTime: current.virtualSeconds, current: managerState(current, all, run.spec), dueActivityIds: due.map(a => a.id),
    changes: all.filter(u => u.sequence > (current.spatial!.lastResolvedSequence ?? 0)).map(u => publicMessage(u)),
    proposal: proposal ?? null, situationPolicy: run.spec.eventGenerator ?? null }),
    { outputType: 'spatialResolution', phase: 'resolve', sourceUtteranceIds: due.map(a => a.sourceUtteranceId), proposalId: proposal?.id ?? null, virtualSeconds: current.virtualSeconds }, all);
  let result: ReturnType<typeof applySpatialResolution>;
  try { result = applySpatialResolution(run.spec, current, all, JSON.parse(call.output), proposal); }
  catch (e) { h.store.patch('invocations', call.id, { status: 'failed', error: errorText(e) }); throw e; }
  if (h.run().status !== 'running') return;
  h.store.transaction(() => {
    let sequence = all.length;
    for (const event of result.output.events) {
      const recipients = audienceNpcIds(run.spec, current, event.audience);
      h.append({ id: randomUUID(), runId: h.id, sequence: ++sequence, speechIndex: null, speakerId: '__environment__', speakerName: '세계 엔진', kind: 'event',
        speech: event.text, action: '', createdAt: now(), invocationId: call.id, deliveryCompletedAt: null, deliveryMs: null,
        worldEvent: { ...event, virtualSeconds: current.virtualSeconds },
        perception: { locationId: event.audience.scope === 'locations' && event.audience.locationIds.length === 1 ? event.audience.locationIds[0] : null,
          virtualSeconds: current.virtualSeconds, speechRecipientIds: recipients, actionRecipientIds: [], audience: event.audience } });
    }
    for (const movement of result.output.movements) {
      const location = run.spec.scenario.spatial!.locations.find(l => l.id === movement.toLocationId)!;
      const character = run.spec.scenario.characters.find(c => c.id === movement.npcId)!;
      const activity = current.spatial!.activities.find(a => a.id === movement.activityId);
      const source = all.find(u => u.id === activity?.sourceUtteranceId);
      const audience = { scope: 'locations' as const, locationIds: [location.id], npcIds: [] };
      h.append({ id: randomUUID(), runId: h.id, sequence: ++sequence, speechIndex: null, speakerId: '__environment__', speakerName: '이동 결과', kind: 'event',
        speech: `${character.name}이(가) ${location.name}에 도착했다.`, action: '', createdAt: now(), invocationId: call.id, deliveryCompletedAt: null, deliveryMs: null,
        worldEvent: { type: movement.kind === 'requested' ? 'actor_result' : 'physical_effect', text: `${character.name}의 위치: ${location.name}`, npcId: character.id,
          evidence: source?.action || null, processId: null, sourceUtteranceId: source?.id ?? null, virtualSeconds: current.virtualSeconds, audience },
        perception: { locationId: location.id, virtualSeconds: current.virtualSeconds, speechRecipientIds: audienceNpcIds(run.spec, result.state, audience), actionRecipientIds: [], audience } });
    }
    result.state.spatial!.lastResolvedSequence = sequence;
    result.state.spatial!.lastWorldCheckAt = current.virtualSeconds;
    saveState(h, result.state, 'world/committed', call.id);
    if (proposal) decideSituation(h, proposal, result.output.proposalDecision!.accepted, result.output.proposalDecision!.reason);
  }); h.changed();
}

export async function runSpatial(h: SimulationHost) {
  if (!h.run().worldState?.spatial) h.store.transaction(() => saveState(h, initialSpatialWorld(h.run().spec), 'spatial/initialized'));
  while (!h.closing() && h.run().status === 'running') {
    await h.flush();
    const current = state(h);
    if (nextClockBoundary(h.run().spec,current) <= current.virtualSeconds) {
      const next = structuredClone(current);
      h.store.transaction(() => {
        for (const u of clockObservations(h.run().spec,next,h.id,history(h).length)) h.append(u);
        saveState(h,next,'world/clock_event');
      }); h.changed(); continue;
    }
    const cycle = state(h).spatial!.cycle;
    if (cycle) {
      if (cycle.stage === 'deciding') await decideCycle(h);
      if (h.run().status !== 'running') break;
      await h.flush();
      if (state(h).spatial!.cycle?.stage === 'planning') await planCycle(h);
      continue;
    }
    if (state(h).spatial!.pendingResolution) { await resolveWorld(h); continue; }
    if (dueActivities(state(h)).length || dueProcesses(state(h)).length) { scheduleResolution(h); continue; }
    const atLimit = history(h).filter(u => u.kind === 'speech').length >= h.run().spec.maxUtterances;
    if (!atLimit) await generateSituation(h);
    if (pendingProposal(h)) { scheduleResolution(h, true); continue; }
    let run = h.run(); let count = history(h).filter(u => u.kind === 'speech').length;
    for (const [i, event] of run.spec.scheduledEvents.entries()) if (event.afterUtterance <= count && !h.run().appliedEvents.includes(i)) {
      h.store.transaction(() => { h.inject(event.text, event.audience); h.store.patch('runs', h.id, { appliedEvents: [...h.run().appliedEvents, i] }); });
    }
    await h.flush();
    if (atLimit) {
      // Settle already chosen work up to its declared horizon. New reactions
      // require another NPC choice and cannot be fabricated after the limit.
      const current = state(h), advanced = structuredClone(current);
      const pending = current.spatial!.activities.filter(a => a.status === 'pending' && !a.waitingNpcIds.length);
      const horizon = current.spatial!.settleUntilSeconds ?? Math.max(current.virtualSeconds,...pending.map(a => a.readyAtSeconds));
      const next = nextSpatialTime(current,nextClockBoundary(run.spec,current));
      if (pending.length && next !== null && next <= horizon) {
        advanced.spatial!.settleUntilSeconds = horizon; advanced.virtualSeconds = next; closePassages(run.spec,advanced);
        h.store.transaction(() => saveState(h,advanced,'spatial/clock_advanced')); continue;
      }
    }
    await h.evaluate(count >= run.spec.maxUtterances);
    run = h.run(); if (run.status !== 'running') break;
    if (count >= run.spec.maxUtterances) { h.store.patch('runs', h.id, { status: 'completed', completedAt: now(), completionReason: 'utterance_limit' }); break; }
    if (run.pauseRequested || run.stepRemaining === 0) { h.store.patch('runs', h.id, { status: 'paused', pausedAt: now(), pauseRequested: false }); break; }
    const remaining = Math.min(run.spec.maxUtterances - count, run.stepRemaining ?? Infinity);
    if (await prepareCycle(h, remaining)) continue;
    const next = nextSpatialTime(state(h), Math.min(nextSituationCheck(h),nextClockBoundary(run.spec,state(h))));
    if (next === null) throw new Error('진행 가능한 NPC·가상 시간 경계가 없습니다. 상태와 반응 대기를 확인하세요.');
    const advanced = structuredClone(state(h)); advanced.virtualSeconds = next;
    closePassages(run.spec,advanced);
    h.store.transaction(() => saveState(h, advanced, 'spatial/clock_advanced')); h.changed();
  }
  if (h.closing() && h.run().status === 'running') h.store.patch('runs', h.id, { status: 'paused', pausedAt: now() });
}
