import type { RunListItem } from './types.js';

export const emptyRunFilters = {
  models: [] as string[], efforts: [] as string[], scenarios: [] as string[], statuses: [] as string[],
  deliveryModes: [] as string[], memoryModes: [] as string[], turnPolicies: [] as string[],
  environmentModes: [] as string[],
  origin: '', costCoverage: '', dateFrom: '', dateTo: '',
  costMin: '', costMax: '', speechMin: '', speechMax: '', tokenMin: '', tokenMax: '',
  npcMin: '', npcMax: '', latencyMin: '', latencyMax: '',
  sort: 'newest',
};
export type RunFilters = typeof emptyRunFilters;
const ranges = [['costMin', 'costMax', '비용'], ['speechMin', 'speechMax', '발화 수'],
  ['tokenMin', 'tokenMax', '토큰 수'], ['npcMin', 'npcMax', 'NPC 수'], ['latencyMin', 'latencyMax', '응답 시간']] as const;

export function filterErrors(filters: RunFilters): string[] {
  const errors: string[] = [];
  for (const [min, max, label] of ranges) {
    for (const field of [min, max]) if (filters[field] && (!Number.isFinite(Number(filters[field])) || Number(filters[field]) < 0)) errors.push(`${label}은 0 이상의 수를 입력하세요.`);
    if (filters[min] && filters[max] && Number(filters[min]) > Number(filters[max])) errors.push(`${label}의 최소값은 최대값 이하여야 합니다.`);
  }
  if (filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo) errors.push('시작 날짜는 종료 날짜 이전이어야 합니다.');
  return [...new Set(errors)];
}

const inRange = (value: number | null | undefined, min: string, max: string) =>
  (!min && !max) || (value != null && Number.isFinite(value) && (!min || value >= Number(min)) && (!max || value <= Number(max)));
const includes = (selected: string[], value: string) => !selected.length || selected.includes(value);

export function filterRuns(runs: RunListItem[], filters: RunFilters, provider = 'all', search = '') {
  if (filterErrors(filters).length) return [];
  const start = filters.dateFrom ? Date.parse(`${filters.dateFrom}T00:00:00+09:00`) : -Infinity;
  const end = filters.dateTo ? Date.parse(`${filters.dateTo}T00:00:00+09:00`) + 86_400_000 : Infinity;
  const query = search.trim().toLocaleLowerCase();
  const matches = runs.filter(run => {
    const cost = run.summary.cost;
    const configs = run.npcConfigs ?? [];
    const text = [run.id, run.experimentId, run.name, run.scenario?.id, run.scenario?.name, run.variant.label,
      run.adapter, run.adapter === 'openai' ? 'OpenAI API' : run.adapter === 'codex' ? 'Codex CLI' : '모의 엔진',
      ...configs.flatMap(c => [c.name, c.model, c.effort]), ...(run.history?.locations ?? [])].join(' ').toLocaleLowerCase();
    const created = Date.parse(run.createdAt);
    return (provider === 'all' || (provider === 'real' ? run.adapter !== 'mock' : run.adapter === provider))
      && (!query || text.includes(query))
      // Model and effort must match the SAME NPC; evaluator/director models are excluded.
      && ((!filters.models.length && !filters.efforts.length) || configs.some(c => includes(filters.models, c.model) && includes(filters.efforts, c.effort)))
      && includes(filters.scenarios, run.scenario?.id ?? '') && includes(filters.statuses, run.status)
      && includes(filters.deliveryModes, run.variant.deliveryMode) && includes(filters.memoryModes, run.variant.memoryMode)
      && includes(filters.turnPolicies, run.variant.turnPolicy)
      && includes(filters.environmentModes, run.environmentMode ?? run.variant.environmentMode ?? (run.summary.quality?.progression ? 'rules' : 'off'))
      && (!filters.origin || (run.history?.readOnly ? 'archive' : 'current') === filters.origin)
      && (!filters.costCoverage || (filters.costCoverage === 'missing' ? cost?.usd == null
        : filters.costCoverage === 'partial' ? cost?.usd != null && cost.unpricedCalls > 0
          : filters.costCoverage === 'assumed' ? (cost?.assumedCalls ?? 0) > 0
            : cost?.usd != null && cost.unpricedCalls === 0))
      && created >= start && created < end
      && inRange(cost?.usd, filters.costMin, filters.costMax)
      && inRange(run.summary.speechCount, filters.speechMin, filters.speechMax)
      && inRange(run.summary.tokens.totalTokens, filters.tokenMin, filters.tokenMax)
      && inRange(run.scenario?.characterCount, filters.npcMin, filters.npcMax)
      && inRange(run.summary.medianMs == null ? null : run.summary.medianMs / 1000, filters.latencyMin, filters.latencyMax);
  });
  const values = (run: RunListItem) => {
    if (filters.sort.startsWith('cost')) return run.summary.cost?.usd;
    if (filters.sort.startsWith('speech')) return run.summary.speechCount;
    if (filters.sort.startsWith('tokens')) return run.summary.tokens.totalTokens;
    if (filters.sort.startsWith('latency')) return run.summary.medianMs;
    return Date.parse(run.createdAt);
  };
  return matches.sort((a, b) => {
    const av = values(a), bv = values(b);
    if (av == null || bv == null) return av == null ? bv == null ? a.id.localeCompare(b.id) : 1 : -1;
    const ascending = filters.sort === 'oldest' || filters.sort.endsWith('_asc');
    return (ascending ? av - bv : bv - av) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
  });
}
