import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyRunFilters, filterErrors, filterRuns, type RunFilters } from '../src/shared/run-filters.js';
import type { RunListItem } from '../src/shared/types.js';

const run = (id: string, options: { date?: string; cost?: number | null; speech?: number; token?: number | null; latency?: number | null; partial?: boolean } = {}): RunListItem => ({
  id, experimentId: 'experiment', name: '실험', adapter: 'openai', status: 'completed', createdAt: options.date ?? '2026-11-01T15:00:00.000Z',
  scenario: { id: 'hestia', name: '헤스티아', characterCount: 6 },
  npcConfigs: [{ characterId: 'a', name: '지안', model: 'terra', effort: 'low' }, { characterId: 'b', name: '바실', model: 'luna', effort: 'high' }],
  variant: { label: '비교 조건', deliveryMode: 'batched_on_turn', memoryMode: 'initial_only', turnPolicy: 'round_robin' },
  summary: { cost: { usd: options.cost === undefined ? 1 : options.cost, unpricedCalls: options.partial ? 1 : 0, assumedCalls: 0 },
    speechCount: options.speech ?? 60, tokens: { totalTokens: options.token === undefined ? 1000 : options.token }, medianMs: options.latency === undefined ? 2000 : options.latency },
  history: { readOnly: true, locations: ['reports/sample.sqlite'] },
} as RunListItem);
const filter = (runs: RunListItem[], changes: Partial<RunFilters>) => filterRuns(runs, { ...emptyRunFilters, ...changes }).map(run => run.id);

test('model and effort match the same resolved NPC, multi-select OR and cross-field AND', () => {
  const runs = [run('a')];
  assert.deepEqual(filter(runs, { models: ['terra'], efforts: ['high'] }), []);
  assert.deepEqual(filter(runs, { models: ['terra', 'luna'], efforts: ['high'], scenarios: ['hestia'] }), ['a']);
  assert.deepEqual(filter(runs, { models: ['evaluation-only-model'] }), []);
  assert.deepEqual(filter(runs, { statuses: ['paused', 'completed'], deliveryModes: ['per_utterance'] }), []);
  assert.deepEqual(filter(runs, { origin: 'current' }), []);
  for (const search of ['헤스티아', 'hestia', '지안', 'luna', 'reports/sample', 'OpenAI API']) {
    assert.equal(filterRuns(runs, emptyRunFilters, 'real', search).length, 1, search);
  }
});

test('single dates and periods use KST midnight inclusively across UTC date boundaries', () => {
  const runs = [run('before', { date: '2026-11-01T14:59:59.999Z' }), run('start'),
    run('last', { date: '2026-11-02T14:59:59.999Z' }), run('after', { date: '2026-11-02T15:00:00.000Z' })];
  assert.deepEqual(filter(runs, { dateFrom: '2026-11-02', dateTo: '2026-11-02', sort: 'oldest' }), ['start', 'last']);
  assert.deepEqual(filter(runs, { dateFrom: '2026-11-02', dateTo: '2026-11-03', sort: 'oldest' }), ['start', 'last', 'after']);
  assert.deepEqual(filter(runs, { dateTo: '2026-11-01' }), ['before']);
});

test('numeric intervals include zero and both boundaries, exclude unknown measurements and report invalid ranges', () => {
  const runs = [run('zero', { cost: 0, speech: 0, token: 0, latency: 0 }), run('one'), run('two', { cost: 2, speech: 120 }),
    run('missing', { cost: null, token: null, latency: null }), run('partial', { cost: 1, partial: true })];
  assert.deepEqual(filter(runs, { costMin: '0', costMax: '0' }), ['zero']);
  assert.deepEqual(filter(runs, { costMin: '1', costMax: '2', sort: 'cost_asc' }), ['one', 'partial', 'two']);
  assert.deepEqual(filter(runs, { costMin: '1', costMax: '2', costCoverage: 'complete', speechMin: '60', speechMax: '120' }), ['one', 'two']);
  assert.deepEqual(filter(runs, { costCoverage: 'partial' }), ['partial']);
  assert.deepEqual(filter(runs, { costCoverage: 'missing' }), ['missing']);
  assert.deepEqual(filter(runs, { tokenMax: '0', latencyMax: '0', npcMin: '6', npcMax: '6' }), ['zero']);
  assert.deepEqual(filter(runs, { latencyMin: '2', latencyMax: '2', costCoverage: 'complete' }), ['one', 'two']);
  assert.deepEqual(filter(runs, { costMin: '2', costMax: '1' }), []);
  assert.ok(filterErrors({ ...emptyRunFilters, costMin: '-1' }).length);
  assert.ok(filterErrors({ ...emptyRunFilters, dateFrom: '2026-12-01', dateTo: '2026-11-01' }).length);
  assert.deepEqual(filter(runs, { sort: 'cost_desc' }), ['two', 'one', 'partial', 'zero', 'missing']);
});
