import type { ExperimentSpec } from '../../shared/schema.js';
import type { BulkRunDeletionPlan, BulkRunDeletionResult, EvaluationFinding, ModelInfo, Run, RunDeletionPlan, RunDetail, RunListItem } from '../../shared/types.js';

export interface HealthResponse { ok: boolean; adapter: string; version: string; historyEnabled: boolean }
export interface HistorySource { path: string; status: 'loaded' | 'unchanged' | 'error'; runs: number; error?: string }
export interface HistoryCatalog { archive?: string; sources: HistorySource[]; runs: number; errors: HistorySource[] }
export interface HistoryResponse extends HistoryCatalog { enabled: boolean }
export type FindingPatch = Partial<Pick<EvaluationFinding, 'review' | 'note'>>;
export type RunControl = 'pause' | 'resume' | 'step' | 'stop' | 'evaluate';

async function request<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data: unknown = await response.json();
  if (!response.ok) {
    const message = data && typeof data === 'object' && 'error' in data ? String(data.error) : response.statusText;
    throw new Error(message);
  }
  return data as T;
}

const runPath = (id: string) => `/runs/${encodeURIComponent(id)}`;
export const api = {
  health: () => request<HealthResponse>('/health'),
  history: () => request<HistoryResponse>('/history'),
  refreshHistory: () => request<HistoryCatalog>('/history/refresh', {}),
  models: () => request<ModelInfo[]>('/models'),
  config: () => request<ExperimentSpec | null>('/config'),
  example: () => request<ExperimentSpec>('/example'),
  saveConfig: (spec: ExperimentSpec) => request<ExperimentSpec>('/config', spec, 'PUT'),
  validate: (spec: ExperimentSpec) => request<{ valid: true; spec: ExperimentSpec }>('/validate', spec),
  createExperiment: (spec: ExperimentSpec, start: boolean) => request<{ experimentId: string; runs: Run[] }>('/experiments', { spec, start }),
  listRuns: () => request<RunListItem[]>('/runs'),
  getRun: (id: string) => request<RunDetail>(runPath(id)),
  deletionPlan: (id: string) => request<RunDeletionPlan>(`${runPath(id)}/deletion`),
  deleteRun: (id: string, token: string) => request<{ deleted: true; runId: string }>(runPath(id), { confirm: true, token }, 'DELETE'),
  bulkDeletionPlan: (runIds: string[]) => request<BulkRunDeletionPlan>('/runs/deletion-preview', { runIds }),
  deleteRuns: (runIds: string[], token: string) => request<BulkRunDeletionResult>('/runs', { runIds, confirm: true, token }, 'DELETE'),
  configUrl: (id: string) => `/api${runPath(id)}/config.json`,
  controlRun: (id: string, control: RunControl) => request<RunDetail>(`${runPath(id)}/${control}`, {}),
  inject: (id: string, text: string, audience?: import('../../shared/spatial-schema.js').Audience) => request<RunDetail>(`${runPath(id)}/inject`, { text, audience }),
  reviewFinding: (id: string, patch: FindingPatch) => request<EvaluationFinding>(`/findings/${encodeURIComponent(id)}`, patch, 'PATCH'),
  exportUrl: (id: string) => `/api${runPath(id)}/export.zip`,
};

export const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
