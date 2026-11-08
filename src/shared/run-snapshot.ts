import type { Run, RunNpcConfig } from './types.js';
import { environmentMode } from './schema.js';

export function resolvedNpcConfigs(run: Run): RunNpcConfig[] {
  return run.spec.scenario.characters.map(character => ({
    characterId: character.id, name: character.name,
    model: run.sessions[character.id]?.config.model ?? character.model ?? run.variant.model ?? run.spec.scenario.defaults.model,
    effort: run.sessions[character.id]?.config.effort ?? character.effort ?? run.variant.effort ?? run.spec.scenario.defaults.effort,
  }));
}

export function runSnapshot(run: Run) {
  return {
    schemaVersion: 1, runId: run.id, experimentId: run.experimentId, variantId: run.variant.id,
    repetition: run.repetition, adapter: run.adapter, createdAt: run.createdAt,
    snapshotHash: run.snapshotHash, appVersion: run.appVersion, cliVersion: run.cliVersion,
    promptVersion: run.promptVersion ?? null,
    ...(run.socialReactionVersion && {socialReactionVersion:run.socialReactionVersion}),
    ...(run.sceneFlowVersion && {sceneFlowVersion:run.sceneFlowVersion}),
    dialoguePromptVersion: run.variant.dialoguePromptVersion ?? null,
    worldPromptVersion: run.variant.worldPromptVersion ?? null,
    worldContextVersion: run.worldContextVersion ?? null,
    apiKeySource: run.adapter === 'openai' ? run.apiCredential?.source ?? 'environment' : null,
    resolvedEnvironmentMode: environmentMode(run.spec, run.variant),
    spec: run.spec, variant: run.variant, resolvedNpcConfigs: resolvedNpcConfigs(run), resolvedSessions: run.sessions,
  };
}
