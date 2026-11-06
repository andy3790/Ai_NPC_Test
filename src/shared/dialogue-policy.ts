// Existing versions are immutable. Add a version instead of editing its text.
export const DIALOGUE_PROMPT_VERSIONS = ['npc-dialogue/1', 'npc-dialogue/2', 'npc-dialogue/3', 'npc-dialogue/4', 'npc-dialogue/5', 'npc-dialogue/6', 'npc-dialogue/7', 'npc-dialogue/8', 'npc-dialogue/9', 'npc-dialogue/10'] as const;
export type DialoguePromptVersion = typeof DIALOGUE_PROMPT_VERSIONS[number];
export const CURRENT_DIALOGUE_PROMPT: DialoguePromptVersion = 'npc-dialogue/5';
export const LEGACY_DIALOGUE_PROMPT: DialoguePromptVersion = 'npc-dialogue/1';
