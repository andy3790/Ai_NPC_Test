import type { RunDetail, RunListItem } from '../../shared/types.js';

export interface RunDataSnapshot {
  runs: RunListItem[];
  detail: RunDetail | null;
  compared: RunDetail[];
}

interface RunDataSource {
  listRuns: () => Promise<RunListItem[]>;
  getRun: (id: string) => Promise<RunDetail>;
  onChange: (snapshot: RunDataSnapshot) => void;
}

/** Owns request ordering and caches; React and SSE only supply selection and invalidations. */
export class RunRefreshCoordinator {
  private runs: RunListItem[] = [];
  private selectedId = '';
  private compareIds: string[] = [];
  private compared: RunDetail[] = [];
  private cache = new Map<string, { version: number; detail: RunDetail }>();
  private versions = new Map<string, number>();
  private detailsInFlight = new Map<string, Promise<void>>();
  private listVersion = 0;
  private listInFlight: Promise<void> | null = null;
  private disposed = false;
  private deletedIds = new Set<string>();

  constructor(private readonly source: RunDataSource) {}

  get snapshot(): RunDataSnapshot {
    const compared = this.compareIds.flatMap(id => {
      const detail = this.cache.get(id)?.detail;
      return detail ? [detail] : [];
    });
    if (compared.length !== this.compared.length || compared.some((detail, index) => detail !== this.compared[index])) this.compared = compared;
    return {
      runs: this.runs,
      detail: this.cache.get(this.selectedId)?.detail ?? null,
      compared: this.compared,
    };
  }

  private publish() { if (!this.disposed) this.source.onChange(this.snapshot); }
  private visibleIds() { return [...new Set([this.selectedId, ...this.compareIds].filter(id => !!id && !this.deletedIds.has(id)))]; }
  forgetRun(id: string) {
    this.deletedIds.add(id);
    this.cache.delete(id);
    this.versions.set(id, (this.versions.get(id) ?? 0) + 1);
    this.runs = this.runs.filter(run => run.id !== id);
    this.compareIds = this.compareIds.filter(value => value !== id);
    if (this.selectedId === id) this.selectedId = '';
    this.publish();
  }
  private trimCache() {
    const visible = new Set(this.visibleIds());
    for (const id of this.cache.keys()) if (!visible.has(id)) this.cache.delete(id);
    for (const id of this.versions.keys()) if (!visible.has(id) && !this.detailsInFlight.has(id)) this.versions.delete(id);
  }

  async setSelection(selectedId: string, compareIds: readonly string[]): Promise<void> {
    if (this.disposed) return;
    this.selectedId = this.deletedIds.has(selectedId) ? '' : selectedId;
    this.compareIds = [...new Set(compareIds)].filter(id => !this.deletedIds.has(id));
    this.trimCache();
    this.publish();
    await Promise.all(this.visibleIds().map(id => this.loadDetail(id)));
  }

  refresh(runId?: string): Promise<void> { return this.refreshRuns(runId ? [runId] : undefined); }

  async refreshRuns(runIds?: readonly string[]): Promise<void> {
    if (this.disposed) return;
    this.listVersion++;
    const changed = runIds?.length ? new Set(runIds) : null;
    const invalidated = changed ?? new Set([...this.versions.keys(), ...this.cache.keys(), ...this.visibleIds()]);
    for (const id of invalidated) {
      if (this.cache.has(id) || this.detailsInFlight.has(id) || this.visibleIds().includes(id)) this.versions.set(id, (this.versions.get(id) ?? 0) + 1);
    }
    await Promise.all([
      this.loadList(),
      ...this.visibleIds().filter(id => !changed || changed.has(id)).map(id => this.loadDetail(id)),
    ]);
  }

  private loadList(): Promise<void> {
    if (this.listInFlight) return this.listInFlight;
    const pending = (async () => {
      while (!this.disposed) {
        const version = this.listVersion;
        const runs = await this.source.listRuns();
        if (this.disposed) return;
        const missing = this.runs.filter(previous => !runs.some(run => run.id === previous.id)).map(run => run.id);
        this.runs = runs.filter(run => !this.deletedIds.has(run.id));
        for (const id of missing) this.forgetRun(id);
        this.publish();
        if (version !== this.listVersion) continue;
        return;
      }
    })().finally(() => { this.listInFlight = null; });
    this.listInFlight = pending;
    return pending;
  }

  private loadDetail(id: string): Promise<void> {
    if (this.deletedIds.has(id)) return Promise.resolve();
    const pending = this.detailsInFlight.get(id);
    if (pending) return pending;
    const cached = this.cache.get(id);
    if (cached && cached.version === (this.versions.get(id) ?? 0)) return Promise.resolve();
    const request = (async () => {
      while (!this.disposed) {
        const version = this.versions.get(id) ?? 0;
        let detail: RunDetail;
        try { detail = await this.source.getRun(id); }
        catch (error) { if (this.deletedIds.has(id)) return; throw error; }
        if (this.disposed) return;
        if (!this.visibleIds().includes(id)) return;
        this.cache.set(id, { version, detail });
        this.publish();
        // One request per resource preserves response order. Publish progress even
        // under continuous events, then follow up if another change arrived.
        if (version !== (this.versions.get(id) ?? 0) && this.visibleIds().includes(id)) continue;
        return;
      }
    })().finally(() => { this.detailsInFlight.delete(id); this.trimCache(); });
    this.detailsInFlight.set(id, request);
    return request;
  }

  dispose() { this.disposed = true; this.cache.clear(); this.compared = []; }
}
