export const WORLD_PROMPT_VERSIONS = ['npc-world/1', 'npc-world/2', 'npc-world/3', 'npc-world/4', 'npc-world/5', 'npc-world/6'] as const;
export type WorldPromptVersion = typeof WORLD_PROMPT_VERSIONS[number];
export const WORLD_PROMPT_VERSION: WorldPromptVersion = 'npc-world/6';
// Runs without a saved world revision keep the default from before version pinning.
// Existing helper sessions always retain their stored instruction text instead.
export const LEGACY_WORLD_PROMPT: WorldPromptVersion = 'npc-world/2';
