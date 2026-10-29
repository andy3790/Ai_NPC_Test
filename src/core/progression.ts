import type { EnvironmentSpec, ExperimentSpec, State } from '../shared/schema.js';
import type { Utterance } from '../shared/types.js';

export function satisfies(state: State, conditions: EnvironmentSpec['goals'][number]['conditions']) {
  return conditions.every(c => {
    const actual = state[c.key];
    return Object.hasOwn(state, c.key) && (c.op === 'eq' ? actual === c.value : c.op === 'neq' ? actual !== c.value :
      typeof actual === 'number' && typeof c.value === 'number' && (c.op === 'gte' ? actual >= c.value : actual <= c.value));
  });
}
// Only engine-authored resolution records change state. NPC prose and manually
// injected narrative never silently satisfy a structured goal.
export function progression(spec: ExperimentSpec, history: Utterance[]) {
  const env = spec.scenario.environment;
  if (!env?.enabled) return null;
  let state = { ...env.initialState };
  const used = new Set<string>();
  const first = new Map<string, number>();
  for (const g of env.goals) if (satisfies(state, g.conditions)) first.set(g.id, 0);
  let lastProgressSpeech = 0; let successfulActions = 0;
  for (const u of history) if (u.kind === 'event' && u.resolution) {
    const r = u.resolution;
    state = { ...r.after }; used.add(r.actionId); successfulActions++; lastProgressSpeech = r.speechIndex;
    for (const g of env.goals) if (!first.has(g.id) && satisfies(state, g.conditions)) first.set(g.id, r.speechIndex);
  }
  const goals = env.goals.map(g => ({ ...g, achieved: satisfies(state, g.conditions), firstAchievedAtSpeech: first.get(g.id) ?? null }));
  return { state, usedActionIds: [...used], goals, achievedGoals: goals.filter(g => g.achieved).length,
    totalGoals: goals.length, allGoalsAchieved: goals.every(g => g.achieved), successfulActions, lastProgressSpeech,
    stalledSpeechCount: history.filter(u => u.kind === 'speech').length - lastProgressSpeech };
}
export function availableActions(spec: ExperimentSpec, history: Utterance[], actorId: string) {
  const current = progression(spec, history);
  return current ? spec.scenario.environment!.actions.filter(a => a.actorIds.includes(actorId) &&
    (!a.once || !current.usedActionIds.includes(a.id)) && satisfies(current.state, a.conditions) &&
    Object.entries(a.effects).some(([key, value]) => current.state[key] !== value)) : [];
}
export function resolveAction(spec: ExperimentSpec, history: Utterance[], actorId: string, actionId: string | null | undefined) {
  if (!actionId) return null;
  const current = progression(spec, history);
  const action = availableActions(spec, history, actorId).find(a => a.id === actionId);
  if (!current || !action) throw new Error(`허용되지 않거나 선행 조건이 충족되지 않은 행동: ${actionId}`);
  return { action, before: current.state, after: { ...current.state, ...action.effects } };
}
export function progressionPrompt(spec: ExperimentSpec, history: Utterance[], actorId: string) {
  const current = progression(spec, history);
  if (!current) return undefined;
  return { ...current, availableActions: availableActions(spec, history, actorId).map(a => ({ id: a.id, label: a.label })),
    instruction: '이 상태는 엔진이 확정한 최신 공개 사실입니다. availableActions 중 본인 성격·판단에 맞는 행동 하나를 지금 시도하면 actionId에 ID를 넣으세요. 행동 결과를 먼저 주장하지 마세요. 엔진이 사전에 정의된 결과를 공개 사건으로 확정합니다. 행동하지 않을 때는 null. 이미 확인된 사실을 다시 확인하자고 반복하지 말고 새 판단·질문·행동을 제시하세요. 가능한 행동이 없으면 다른 사람에게 필요한 선택을 구체적으로 요청하세요. 다른 사람의 동의나 결과를 대신 확정하지 마세요. 모든 목표가 달성된 후에는 확인 반복 대신 그 결과에 대한 본인 관점으로 대화하세요.' };
}
