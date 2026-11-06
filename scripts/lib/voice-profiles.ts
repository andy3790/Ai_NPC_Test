import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { z } from 'zod';
import type { Character } from '../../src/shared/schema.js';
import { sha256 } from './dialogue-eval.js';

const voiceSchema = z.object({ speechStyle: z.string().trim().min(1), exampleDialogue: z.string().trim().min(1) }).strict();
const registrySchema = z.object({ current: z.string(), versions: z.record(z.string(), z.object({
  introduced: z.string(), origin: z.string(), reason: z.string().trim().min(1), voiceFile: z.string(), includeCommonGuidance: z.boolean(),
}).strict()) }).strict();
export function loadVoiceProfile(version: string, root = resolve('assets/seowol')) {
  const registryText = readFileSync(resolve(root, 'profile-versions.json'), 'utf8');
  const registry = registrySchema.parse(JSON.parse(registryText)), policy = registry.versions[version];
  if (!policy) throw Error('Unknown voice profile: ' + version);
  const filename = resolve(root, policy.voiceFile);
  if (!filename.startsWith(resolve(root) + sep)) throw Error('Voice file is outside the asset pack');
  const text = readFileSync(filename, 'utf8');
  const voice = z.object({ version: z.string(), characters: z.record(z.string(), voiceSchema) }).parse(JSON.parse(text));
  const interactionText = readFileSync(resolve(root, 'interaction.json'), 'utf8');
  const interaction = z.object({ version: z.string(), guidance: z.string().trim().min(1) }).parse(JSON.parse(interactionText));
  return { version, policy, voice, interaction, hashes: { registry: sha256(registryText), voice: sha256(text), interaction: sha256(interactionText) } };
}
export type VoiceProfile = ReturnType<typeof loadVoiceProfile>;
export function withVoiceProfile(character: Character, profile: VoiceProfile): Character {
  const voice = profile.voice.characters[character.id];
  if (!voice) throw Error('Profile does not define character: ' + character.id);
  // Only the two author-controlled voice fields change. Facts, relationships,
  // private memories, personality and behavior stay byte-for-byte intact.
  return { ...character, speechStyle: (profile.policy.includeCommonGuidance ? profile.interaction.guidance + '\n\n' : '') + voice.speechStyle,
    exampleDialogue: voice.exampleDialogue };
}
