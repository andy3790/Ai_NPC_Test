import type { RunDetail, RunRecords } from '../shared/types.js';
import { buildRunSummary } from './summary.js';

export function buildRunDetail(data: RunRecords, activeIncrement = 0): RunDetail {
  return { ...data, summary: buildRunSummary(data, activeIncrement) };
}
