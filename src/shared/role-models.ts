import defaults from '../config/role-defaults.json' with { type: 'json' };
import type { ModelConfig } from './schema.js';
import type { ModelInfo } from './types.js';

export const apiRoleDefaults = defaults;
export const simulationEffort = (value: string) => ['none','minimal','low','medium','high'].includes(value);
export function preferredEffort(model?: ModelInfo, requested?: string) {
  return [requested,model?.defaultEffort,'low',...(model?.efforts ?? [])].find(e => e && simulationEffort(e) && model?.efforts.includes(e)) ?? 'low';
}

export function availableRoleModels(models: ModelInfo[]) {
  function select(preferred: ModelConfig): ModelConfig {
    const available = models.find(m => m.id === preferred.model);
    if (!available) return { ...preferred };
    return { model: available.id, effort: preferredEffort(available,preferred.effort) };
  }
  return { npc: select(defaults.npc), worldEngine: select(defaults.worldEngine), director: select(defaults.director) };
}
