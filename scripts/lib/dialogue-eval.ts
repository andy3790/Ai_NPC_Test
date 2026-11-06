import { createHash } from 'node:crypto';
import { z } from 'zod';
import { characterSchema, experimentSchema } from '../../src/shared/schema.js';
import type { Utterance } from '../../src/shared/types.js';
import type { DialoguePromptVersion } from '../../src/shared/dialogue-policy.js';
import { baseInstructions, persona, speakerPrompt } from '../../src/core/prompts.js';

const nonempty = z.string().trim().min(1);
export const dialogueCasesSchema = z.object({
  version: nonempty,
  cases: z.array(z.object({
    id: nonempty, split: z.enum(['development', 'holdout']), focus: nonempty,
    world: nonempty, situation: nonempty, speakerId: nonempty,
    characters: z.array(characterSchema).min(2),
    history: z.array(z.object({ speakerId: nonempty, speech: z.string(), action: z.string().default('') })),
    review: z.array(nonempty).min(1),
  })).min(1),
}).superRefine((suite, context) => {
  const ids = new Set<string>();
  for (const c of suite.cases) {
    if (ids.has(c.id)) context.addIssue({ code: 'custom', message: `Duplicate case: ${c.id}` });
    ids.add(c.id);
    const actors = new Set(c.characters.map(a => a.id));
    if (actors.size !== c.characters.length || !actors.has(c.speakerId) || c.history.some(h => !actors.has(h.speakerId))) {
      context.addIssue({ code: 'custom', message: `Invalid case actors: ${c.id}` });
    }
  }
});
export type DialogueCase = z.infer<typeof dialogueCasesSchema>['cases'][number];
export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export function caseInput(c: DialogueCase, version: DialoguePromptVersion, model: string, effort: string) {
  const spec = experimentSchema.parse({ schemaVersion: 1, name: c.id,
    scenario: { id: c.id, name: c.id, world: c.world, situation: c.situation, characters: c.characters, defaults: { model, effort } },
    variants: [{ id: 'sample', label: 'sample', environmentMode: 'off', dialoguePromptVersion: version }],
    maxUtterances: 1, evaluation: { enabled: false, model, effort }, director: { model, effort },
  });
  const instructions = persona(spec, spec.scenario.characters.find(a => a.id === c.speakerId)!, spec.variants[0]);
  const messages = c.history.map((h, i) => ({ ...h, id: `message-${i + 1}`, sequence: i + 1, kind: 'speech',
    speakerName: c.characters.find(a => a.id === h.speakerId)!.name } as Utterance));
  const input = speakerPrompt(messages);
  return { instructions, input, instructionsSha256: sha256(baseInstructions + '\n' + instructions), inputSha256: sha256(input) };
}

// Counterbalance both first-call order and A/B presentation across repetitions.
export function policyOrder(caseIndex: number, repetition: number,
  baseline: DialoguePromptVersion = 'npc-dialogue/1', candidate: DialoguePromptVersion = 'npc-dialogue/2'): DialoguePromptVersion[] {
  return (caseIndex + repetition) % 2 ? [candidate, baseline] : [baseline, candidate];
}

export interface ReviewSample { caseId: string; repetition: number; slot: string; status: string; output: string }
export function renderReview(cases: DialogueCase[], samples: ReviewSample[]) {
  const lines = ['# 대화 비교 검토', '',
    '생성 문장은 원문 그대로다. A/B는 매 비교마다 바뀌며 정답 순서가 아니다. 모델·정책 매핑은 manifest.json에 있다.',
    '작성자가 직접 평가하면 비독립 검토로 표시한다. 숫자 길이·반말·침묵을 자연스러움 점수로 바꾸지 않는다.', '',
    '각 쌍에 선호(A/B/tie/neither), 근거 인용, 지식·관계·상대 행동 침범 여부를 기록한다.', ''];
  for (const c of cases) {
    for (const repetition of [...new Set(samples.filter(s => s.caseId === c.id).map(s => s.repetition))]) {
      lines.push(`## ${c.id} / ${repetition}`, '', c.situation, '',
        ...c.history.map(h => `${c.characters.find(a => a.id === h.speakerId)!.name}: ${h.speech}${h.action ? ` [${h.action}]` : ''}`), '',
        `이번 화자: ${c.characters.find(a => a.id === c.speakerId)!.name}`, '',
        ...c.review.map(item => `- ${item}`), '');
      for (const s of samples.filter(s => s.caseId === c.id && s.repetition === repetition)) {
        lines.push(`### ${s.slot} (${s.status})`, '', '```json', s.output, '```', '');
      }
      lines.push('판정: 미검토', '근거:', '지식·관계·행동 경계:', '');
    }
  }
  return lines.join('\n');
}
