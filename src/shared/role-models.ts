import defaults from '../config/role-defaults.json' with { type: 'json' };
import type { ModelConfig } from './schema.js';
import type { ModelInfo } from './types.js';

export const apiRoleDefaults = defaults;

export function availableRoleModels(models: ModelInfo[], fallback: ModelConfig) {
  const accountDefault = models.find(m => m.isDefault) ?? models.find(m => m.id === fallback.model) ?? models[0];
  function select(preferred: ModelConfig): ModelConfig {
    const available = models.find(m => m.id === preferred.model) ?? accountDefault;
    if (!available) return fallback;
    const effort = available.efforts.includes(preferred.effort) ? preferred.effort : available.defaultEffort;
    return { model: available.id, effort };
  }
  return { npc: select(defaults.npc), worldEngine: select(defaults.worldEngine), director: select(defaults.director) };
}
