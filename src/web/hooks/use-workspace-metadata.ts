import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExperimentSpec } from '../../shared/schema.js';
import type { ModelInfo } from '../../shared/types.js';
import { api, errorMessage, type HealthResponse, type HistoryResponse } from '../api/client.js';

export function useWorkspaceMetadata(onError: (message: string) => void) {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [history, setHistory] = useState<HistoryResponse | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [spec, setSpec] = useState<ExperimentSpec | null>(null);
  const errorHandler = useRef(onError); errorHandler.current = onError;
  const mounted = useRef(false), generation = useRef(0);

  const refreshConnection = useCallback(async () => {
    const requestId = ++generation.current;
    const current = () => mounted.current && requestId === generation.current;
    const nextHealth = await api.health();
    if (!current()) return;
    setHealth(nextHealth);
    if (!current()) return;
    setModels([]);
    const config = await api.config();
    if (!current()) return;
    if (config) setSpec(previous => previous ?? config);
    const nextModels = await api.models();
    if (!current()) return;
    setModels(nextModels);
    if (!config) {
      const example = await api.example();
      if (current()) setSpec(previous => previous ?? example);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const refresh = () => { void refreshConnection().catch(error => { if (mounted.current) errorHandler.current(errorMessage(error)); }); };
    refresh();
    void api.history().then(value => { if (mounted.current) setHistory(value); }).catch(error => { if (mounted.current) errorHandler.current(errorMessage(error)); });
    const events = new EventSource('/api/events');
    let connected = false;
    events.onmessage = event => {
      try {
        const type = JSON.parse(event.data).type;
        if (type === 'connected' && connected) refresh();
        if (type === 'connected') connected = true;
      } catch { /* Ignore non-JSON heartbeats. */ }
    };
    window.addEventListener('focus', refresh);
    return () => { mounted.current = false; generation.current++; events.close(); window.removeEventListener('focus', refresh); };
  }, [refreshConnection]);

  const refreshHistory = async () => {
    const catalog = await api.refreshHistory();
    setHistory({ enabled: true, ...catalog });
  };
  return { health, history, models, spec, setSpec, refreshHistory };
}
