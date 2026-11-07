import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExperimentSpec } from '../../shared/schema.js';
import type { ApiKeyStatus, ModelInfo } from '../../shared/types.js';
import { api, errorMessage, type HealthResponse, type HistoryResponse } from '../api/client.js';
import { installModelCatalog } from '../../shared/model-catalog.js';

export function useWorkspaceMetadata(onError: (message: string) => void) {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [history, setHistory] = useState<HistoryResponse | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [spec, setSpec] = useState<ExperimentSpec | null>(null);
  const [keyStatus, setKeyStatus] = useState<ApiKeyStatus | null>(null);
  const errorHandler = useRef(onError); errorHandler.current = onError;
  const mounted = useRef(false), generation = useRef(0);

  const refreshConnection = useCallback(async () => {
    const requestId = ++generation.current;
    const current = () => mounted.current && requestId === generation.current;
    const nextHealth = await api.health();
    if (!current()) return;
    // Prices come from the running server, so a JSON edit needs no web rebuild.
    const catalog = await api.modelCatalog();
    if (!current()) return;
    installModelCatalog(catalog);
    setHealth(nextHealth);
    // Establish the browser cookie before any request that selects a personal key.
    const keys = nextHealth.adapter === 'openai' ? await api.keyStatus() : null;
    if (!current()) return;
    setKeyStatus(keys);
    setModels([]);
    const config = await api.config();
    if (!current()) return;
    if (config) setSpec(previous => previous ?? config);
    if (keys && !keys.configured) { setModels([]); return; }
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
    const loadHistory = () => { void api.history().then(value => { if (mounted.current) setHistory(value); }).catch(error => { if (mounted.current) errorHandler.current(errorMessage(error)); }); };
    refresh();
    loadHistory();
    const events = new EventSource('/api/events');
    let connected = false;
    events.onmessage = event => {
      try {
        const type = JSON.parse(event.data).type;
        if (type === 'history-refreshed') loadHistory();
        if (type === 'credentials-changed' || (type === 'connected' && connected)) refresh();
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
  return { health, history, models, spec, setSpec, refreshHistory, keyStatus, refreshConnection };
}
