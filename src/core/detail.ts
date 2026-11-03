import type { CallKind, RunDetail } from '../shared/types.js';
import { aggregate } from './metrics.js';
import { qualityMetrics } from './quality.js';

export function buildRunDetail(data: Omit<RunDetail, 'summary' | 'history'>, activeIncrement = 0): RunDetail {
  const { run, utterances, invocations, findings, evaluations, receipts } = data;
    const count = utterances.filter(u => u.kind === 'speech').length; const evaluated = new Set<number>();
    const repetitionEvaluated = new Set<number>();
    for (const e of evaluations.filter(e => e.status === 'completed')) for (let i = e.from; i <= e.to; i++) evaluated.add(i);
    for (const e of evaluations.filter(e => e.status === 'completed')) {
      const version = String(invocations.find(c => c.id === e.invocationId)?.metadata.promptVersion ?? '').match(/^npc-lab\/(\d+)/);
      if (version && Number(version[1]) >= 2) for (let i = e.from; i <= e.to; i++) repetitionEvaluated.add(i);
    }
    const issues = findings.filter(f => f.review !== 'dismissed' && f.verdict === 'issue');
    const issueUtterances = new Set(issues.map(f => f.utteranceId)); const total = aggregate(invocations);
    const end = run.completedAt ? Date.parse(run.completedAt) : Date.now();
    return { run, utterances, invocations, findings, evaluations, receipts, summary: {
      ...total, speechCount: count, pendingReceipts: receipts.filter(r => r.status !== 'delivered').length,
      byKind: Object.fromEntries((['speech', 'receive', 'director', 'evaluation'] as CallKind[]).map(k => [k, aggregate(invocations.filter(c => c.kind === k))])),
      tokensPerSpeech: count && total.tokens.totalTokens !== null ? total.tokens.totalTokens / count : null,
      evaluatedUtterances: evaluated.size, evaluationFailures: evaluations.filter(e => e.status === 'failed').length,
      firstIssue: utterances.find(u => issueUtterances.has(u.id))?.speechIndex ?? null,
      issueRate: evaluated.size ? issueUtterances.size / evaluated.size : null,
      categories: Object.fromEntries([...new Set(findings.map(f => f.category))].map(k => [k, issues.filter(f => f.category === k).length])),
      confirmedIssues: issues.filter(f => f.review === 'confirmed').length,
      quality: qualityMetrics(run.spec, utterances, findings, repetitionEvaluated.size),
      elapsedMs: run.startedAt ? end - Date.parse(run.startedAt) : 0, activeMs: run.activeMs + (activeIncrement),
      timingComplete: run.timingComplete ?? true,
      pausedMs: run.pausedMs + (run.pausedAt && !run.completedAt ? Date.now() - Date.parse(run.pausedAt) : 0),
    } };
  }
