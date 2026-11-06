import { z } from 'zod';
import type { WorldState } from '../../src/shared/world-schema.js';
import type { Utterance } from '../../src/shared/types.js';
import { applyWorldOutput, worldResponseContract } from '../../src/core/world.js';

export const worldCasesSchema = z.object({
  version: z.string().min(1),
  cases: z.array(z.object({ id: z.string().min(1), split: z.enum(['development', 'holdout']),
    input: z.string().min(1), eventExpectation: z.enum(['silent', 'disclose']), review: z.array(z.string().min(1)).min(1),
  })).min(1),
}).superRefine((suite, ctx) => {
  if (new Set(suite.cases.map(c => c.id)).size !== suite.cases.length) ctx.addIssue({ code: 'custom', message: 'Duplicate case IDs' });
  for (const c of suite.cases) {
    try {
      const p = JSON.parse(c.input);
      if (p.task !== 'environment' || !p.currentAction || !Array.isArray(p.npcs) || !Array.isArray(p.state?.facts) || !Array.isArray(p.state?.processes)) throw new Error();
    } catch { ctx.addIssue({ code: 'custom', message: `Invalid world input: ${c.id}` }); }
  }
});
export type WorldCase = z.infer<typeof worldCasesSchema>['cases'][number];

export function inspectWorldResponse(c: WorldCase, output: string, version: string | null = null) {
  const p = JSON.parse(c.input);
  const source = { ...p.currentAction, speechIndex: p.state.processedSpeechCount + 1 } as Utterance;
  try {
    const validated = worldResponseContract(version, source).validator.parse(JSON.parse(output));
    const applied = applyWorldOutput(p.state as WorldState, validated, source, p.npcs.map((n: { id: string }) => n.id));
    return { valid: true, error: null, eventExpectationMet: c.eventExpectation === 'silent' ? applied.output.events.length === 0 : applied.output.events.length > 0,
      eventCount: applied.output.events.length, nextState: applied.state };
  } catch (error) {
    return { valid: false, error: error instanceof Error ? error.message : String(error), eventExpectationMet: false, eventCount: null, nextState: null };
  }
}
