import type { CallKind, Run, RunHistory, RunListItem, RunRecords, RunSummary } from '../shared/types.js';
import { aggregate } from './metrics.js';
import { qualityMetrics } from './quality.js';
import { resolvedNpcConfigs } from '../shared/run-snapshot.js';
import { environmentMode } from '../shared/schema.js';

// Time advances without database mutations. Refresh it independently of the
// expensive aggregation while a run is paused or waiting for a model event.
export function withRunTiming(summary: RunSummary, run: Run, activeIncrement = 0): RunSummary {
  const currentTime = Date.now();
  const end = run.completedAt ? Date.parse(run.completedAt) : currentTime;
  return { ...summary,
    elapsedMs: run.startedAt ? end - Date.parse(run.startedAt) : 0,
    activeMs: run.activeMs + activeIncrement,
    timingComplete: run.timingComplete ?? true,
    pausedMs: run.pausedMs + (run.pausedAt && !run.completedAt ? currentTime - Date.parse(run.pausedAt) : 0),
  };
}

export function buildRunSummary(data: RunRecords, activeIncrement = 0): RunSummary {
  const { run, utterances, invocations, findings, evaluations, receipts } = data;
  const count = utterances.filter(u => u.kind === 'speech').length;
  const evaluated = new Set<number>(), repetitionEvaluated = new Set<number>();
  const callsById = new Map(invocations.map(call => [call.id, call]));
  for (const evaluation of evaluations.filter(e => e.status === 'completed')) {
    const version = String(callsById.get(evaluation.invocationId ?? '')?.metadata.promptVersion ?? '').match(/^npc-lab\/(\d+)/);
    for (let index = evaluation.from; index <= evaluation.to; index++) {
      evaluated.add(index);
      if (version && Number(version[1]) >= 2) repetitionEvaluated.add(index);
    }
  }
  const issues = findings.filter(f => f.review !== 'dismissed' && f.verdict === 'issue');
  const issueUtterances = new Set(issues.map(f => f.utteranceId));
  const total = aggregate(invocations, run.adapter);
  const byKind = Object.fromEntries((['speech', 'receive', 'director', 'evaluation', 'environment', 'event_generation'] as CallKind[])
    .map(kind => [kind, aggregate(invocations.filter(call => call.kind === kind), run.adapter)])) as RunSummary['byKind'];
  return withRunTiming({
    ...total, speechCount: count, pendingReceipts: receipts.filter(receipt => receipt.status !== 'delivered').length,
    byKind, tokensPerSpeech: count && total.tokens.totalTokens !== null ? total.tokens.totalTokens / count : null,
    evaluatedUtterances: evaluated.size, evaluationFailures: evaluations.filter(e => e.status === 'failed').length,
    firstIssue: utterances.find(utterance => issueUtterances.has(utterance.id))?.speechIndex ?? null,
    issueRate: evaluated.size ? issueUtterances.size / evaluated.size : null,
    categories: Object.fromEntries([...new Set(findings.map(f => f.category))].map(category => [category, issues.filter(f => f.category === category).length])),
    confirmedIssues: issues.filter(f => f.review === 'confirmed').length,
    quality: qualityMetrics(run.spec, utterances, findings, repetitionEvaluated.size, run.variant),
    elapsedMs: 0, activeMs: 0, timingComplete: true, pausedMs: 0,
  }, run, activeIncrement);
}

export function matchesProvider(run: Pick<Run, 'adapter'>, provider?: string) {
  return !provider || provider === 'all' || (provider === 'real' ? run.adapter !== 'mock' : run.adapter === provider);
}

export function toRunListItem(run: Run, summary: RunSummary, history?: RunHistory | null): RunListItem {
  const { spec, sessions: _sessions, helperSessions: _helpers, worldState: _worldState, eventGeneratorState: _eventState, sessionCleanup: _cleanup, ...item } = run;
  return { ...item, maxUtterances: spec.maxUtterances, summary, environmentMode: environmentMode(spec, run.variant),
    scenario: { id: spec.scenario.id, name: spec.scenario.name, characterCount: spec.scenario.characters.length },
    npcConfigs: resolvedNpcConfigs(run), ...(history !== undefined ? { history } : {}) };
}
