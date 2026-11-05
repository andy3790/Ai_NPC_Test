import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage } from '../api/client.js';
import { RunRefreshCoordinator, type RunDataSnapshot } from './run-refresh.js';

export function useRunData(selectedId: string, compareIds: readonly string[], onError: (message: string) => void) {
  const [snapshot, setSnapshot] = useState<RunDataSnapshot>({ runs: [], detail: null, compared: [] });
  const coordinator = useRef<RunRefreshCoordinator | null>(null);
  const latest = useRef({ selectedId, compareIds, onError });
  latest.current = { selectedId, compareIds, onError };

  useEffect(() => {
    const data = new RunRefreshCoordinator({ listRuns: api.listRuns, getRun: api.getRun, onChange: setSnapshot });
    coordinator.current = data;
    let active = true;
    const report = (error: unknown) => { if (active) latest.current.onError(errorMessage(error)); };
    void data.setSelection(latest.current.selectedId, latest.current.compareIds).catch(report);
    void data.refresh().catch(report);

    // Batch notification bursts, while keeping the changed run identities.
    const changed = new Set<string>();
    let allChanged = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stream = new EventSource('/api/events');
    stream.onmessage = event => {
      try {
        const value: unknown = JSON.parse(event.data);
        if (value && typeof value === 'object' && 'runId' in value && typeof value.runId === 'string' && value.runId) {
          if ('type' in value && value.type === 'deleted') data.forgetRun(value.runId);
          changed.add(value.runId);
        }
        else allChanged = true; // Initial connection and reconnect both restore current state.
      } catch { allChanged = true; }
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        const ids = [...changed]; changed.clear();
        const refreshAll = allChanged; allChanged = false;
        if (refreshAll) void data.refresh().catch(report);
        else void data.refreshRuns(ids).catch(report);
      }, 350);
    };
    return () => {
      active = false;
      stream.close();
      if (timer) clearTimeout(timer);
      data.dispose();
      if (coordinator.current === data) coordinator.current = null;
    };
  }, []);

  useEffect(() => {
    const data = coordinator.current;
    void data?.setSelection(selectedId, compareIds).catch(error => {
      if (coordinator.current === data) latest.current.onError(errorMessage(error));
    });
  }, [selectedId, compareIds]);

  const refresh = useCallback((runId?: string) => coordinator.current?.refresh(runId) ?? Promise.resolve(), []);
  const forgetRun = useCallback((runId: string) => coordinator.current?.forgetRun(runId), []);
  const compared = useMemo(() => compareIds.flatMap(id => {
    const detail = snapshot.compared.find(item => item.run.id === id);
    return detail ? [detail] : [];
  }), [compareIds, snapshot.compared]);
  // Selection changes render before effects run; never expose the previous run in that frame.
  return {
    allRuns: snapshot.runs,
    detail: snapshot.detail?.run.id === selectedId ? snapshot.detail : null,
    compared,
    refresh,
    forgetRun,
  };
}
