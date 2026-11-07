import { environmentMode, experimentSchema } from '../../src/shared/schema.js';
import type { DialoguePromptVersion } from '../../src/shared/dialogue-policy.js';
import type { WorldPromptVersion } from '../../src/shared/world-policy.js';

interface ConversationOptions {
  model: string; effort: string; baseline: DialoguePromptVersion; candidate: DialoguePromptVersion;
  turns: number; repetitions: number; worldModel?: string; worldEffort: string;
  worldBaseline?: WorldPromptVersion; worldCandidate?: WorldPromptVersion;
}

export function prepareConversations(fixtures: unknown[], options: ConversationOptions) {
  const specs = fixtures.map((fixture, i) => {
    const spec = experimentSchema.parse(fixture);
    spec.scenario.defaults = { model: options.model, effort: options.effort };
    for (const c of spec.scenario.characters) { delete c.model; delete c.effort; }
    spec.evaluation.enabled = false; spec.concurrentRuns = 1; spec.maxConcurrentCalls = 1; spec.timeoutMs = 90_000;
    spec.repetitions = options.repetitions; spec.maxUtterances = options.turns;
    const mode = environmentMode(spec, spec.variants[0]);
    const characterPerformanceVersion = spec.variants[0].characterPerformanceVersion ?? 'off';
    if (!['off', 'ai'].includes(mode)) throw new Error('This probe supports off/ai environments only.');
    if ((options.worldBaseline || options.worldCandidate) && (mode !== 'ai' || !options.worldBaseline || !options.worldCandidate ||
        options.worldBaseline === options.worldCandidate || options.baseline !== options.candidate)) throw new Error('World comparisons require AI mode, distinct world policies and one fixed NPC policy.');
    if (options.worldModel) spec.worldEngine = { model: options.worldModel, effort: options.worldEffort };
    const conditions = [{ dialoguePromptVersion: options.baseline, worldPromptVersion: options.worldBaseline },
      { dialoguePromptVersion: options.candidate, worldPromptVersion: options.worldCandidate }];
    if (i % 2) conditions.reverse();
    spec.variants = conditions.map((condition, index) => ({ id: `condition-${index}`, label: [condition.dialoguePromptVersion, condition.worldPromptVersion].filter(Boolean).join(' + '), ...condition,
      environmentMode: mode, characterPerformanceVersion, stopOnSilence: true, deliveryMode: 'batched_on_turn', memoryMode: 'initial_only', turnPolicy: 'round_robin', eventGeneration: false }));
    return experimentSchema.parse(spec);
  });
  const expectedCalls = specs.reduce((n, s) => n + s.variants.length * s.maxUtterances * s.repetitions *
    (environmentMode(s, s.variants[0]) === 'ai' ? 2 : 1), 0);
  return { specs, expectedCalls };
}
