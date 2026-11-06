// Existing versions are immutable. Add a version instead of editing its text.
export const DIALOGUE_PROMPT_VERSIONS = ['npc-dialogue/1', 'npc-dialogue/2', 'npc-dialogue/3'] as const;
export type DialoguePromptVersion = typeof DIALOGUE_PROMPT_VERSIONS[number];
export const CURRENT_DIALOGUE_PROMPT: DialoguePromptVersion = 'npc-dialogue/3';
export const LEGACY_DIALOGUE_PROMPT: DialoguePromptVersion = 'npc-dialogue/1';
