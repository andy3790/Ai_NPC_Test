import type { ExperimentSpec } from '../shared/schema.js';
import type { EvaluationFinding, Utterance } from '../shared/types.js';
import { progression } from './progression.js';
const normalize = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const grams = (text: string) => new Set(Array.from({ length: Math.max(0, text.length - 2) }, (_, i) => text.slice(i, i + 3)));
function similarity(a: Set<string>, b: Set<string>) {
  const common = [...a].filter(x => b.has(x)).length;
  return a.size + b.size ? 2 * common / (a.size + b.size) : 0;
}
export function repetitionMetrics(spec: ExperimentSpec, history: Utterance[]) {
  const window = spec.evaluation.repetitionWindow ?? 12, threshold = spec.evaluation.repetitionThreshold ?? .72, minChars = spec.evaluation.repetitionMinChars ?? 20;
  const speeches = history.filter(u => u.kind === 'speech');
  const prepared = speeches.map(u => ({ u, text: normalize(u.speech), grams: grams(normalize(u.speech)) }));
  const matches: { utteranceId: string; speechIndex: number; previousUtteranceId: string; previousSpeechIndex: number; similarity: number }[] = [];
  let eligible = 0;
  for (let i = 0; i < prepared.length; i++) {
    const item = prepared[i]; if (item.text.length < minChars) continue;
    const candidates = prepared.slice(Math.max(0, i - window), i).filter(x => x.u.speakerId === item.u.speakerId && x.text.length >= minChars);
    if (!candidates.length) continue;
    eligible++;
    const best = candidates.map(x => ({ x, score: similarity(item.grams, x.grams) })).sort((a, b) => b.score - a.score)[0];
    if (best.score >= threshold) matches.push({ utteranceId: item.u.id, speechIndex: item.u.speechIndex!, previousUtteranceId: best.x.u.id, previousSpeechIndex: best.x.u.speechIndex!, similarity: best.score });
  }
  return { algorithm: 'same-speaker-char-trigram-dice/v1', window, threshold, minChars, totalSpeeches: speeches.length,
    eligibleSpeeches: eligible, repeatedSpeeches: matches.length, rate: eligible ? matches.length / eligible : null, matches };
}
export function qualityMetrics(spec: ExperimentSpec, history: Utterance[], findings: EvaluationFinding[], evaluated: number) {
  const semantic = new Set(findings.filter(f => f.category === 'repetition' && f.verdict === 'issue' && f.review !== 'dismissed').map(f => f.utteranceId));
  return { repetition: repetitionMetrics(spec, history), semanticRepetition: { flaggedSpeeches: semantic.size, evaluatedSpeeches: evaluated, rate: evaluated ? semantic.size / evaluated : null }, progression: progression(spec, history) };
}
