import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import type { RunDetail } from '../src/shared/types.js';
if (!process.argv[2]) throw new Error('사용법: node --import tsx scripts/summarize-canon-120.ts reports/<실험-폴더>');
const root = resolve(process.argv[2]);
const d: RunDetail = JSON.parse(await readFile(join(root, 'detail.json'), 'utf8'));
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
assert.equal(d.run.status, 'completed'); assert.equal(d.summary.speechCount, 120);
assert.equal(d.run.variant.deliveryMode, 'batched_on_turn'); assert.equal(d.run.variant.memoryMode, 'initial_only');
assert.equal(d.run.repetition, 1); assert.equal(d.run.spec.repetitions, 1); assert.equal(d.run.spec.variants.length, 1);
const speeches = d.utterances.filter(u => u.kind === 'speech'), events = d.utterances.filter(u => u.kind === 'event');
const attempts = d.invocations.filter(c => c.kind === 'speech');
const calls = attempts.filter(c => c.status === 'completed');
assert.equal(calls.length, 120); assert.equal(d.invocations.filter(c => c.kind === 'receive').length, 0);
assert.equal(d.invocations.filter(c => c.kind === 'evaluation').length, 12);
assert.equal(d.invocations.length, 132 + attempts.filter(c => c.status !== 'completed').length); assert.equal(events.length, 3);
assert.equal(d.receipts.length, 618); assert.equal(d.receipts.filter(r => r.status !== 'delivered').length, 15);
assert.equal(d.summary.missingUsage, 0);
assert.ok(d.invocations.every(c => ['completed', 'failed', 'cancelled'].includes(c.status) && c.model === 'gpt-6.1-terra' && c.effort === 'medium'));
assert.equal(new Set(Object.values(d.run.sessions).map(s => s.threadId)).size, 6);
assert.equal(d.summary.quality.progression, null);
const delivered = new Map<string, Set<string>>();
for (const c of attempts) {
  const input = JSON.parse(c.input); assert.equal(input.originalCharacterAndWorld, undefined);
  const messages = (input.messages ?? []) as any[]; const seen = delivered.get(c.characterId!) ?? new Set<string>();
  assert.deepEqual(messages.map(m => m.sequence), messages.map(m => m.sequence).toSorted((a, b) => a - b));
  const speech = speeches.find(u => u.id === c.utteranceId)!;
  assert.ok(speech, 'Every generation attempt is linked to its eventual public speech');
  for (const m of messages) {
    assert.ok(d.utterances.some(u => u.id === m.id && u.sequence < speech.sequence));
    assert.notEqual(m.speakerId, c.characterId); assert.ok(!seen.has(m.id)); seen.add(m.id);
  }
  delivered.set(c.characterId!, seen);
}
for (const character of d.run.spec.scenario.characters) {
  assert.equal(speeches.filter(u => u.speakerId === character.id).length, 20);
  const seen = delivered.get(character.id)!;
  assert.deepEqual([...seen].sort(), d.receipts.filter(r => r.characterId === character.id && r.status === 'delivered').map(r => r.utteranceId).sort());
  const instructions = d.run.sessions[character.id].instructions;
  for (const other of d.run.spec.scenario.characters.filter(c => c.id !== character.id)) assert.ok(!instructions.includes(other.memories));
  for (const event of d.run.spec.scheduledEvents) assert.ok(!instructions.includes(event.text));
}
for (let i = 0; i < 3; i++) {
  assert.equal(events[i].speech, d.run.spec.scheduledEvents[i].text);
  assert.equal(speeches.filter(s => s.sequence < events[i].sequence).length, d.run.spec.scheduledEvents[i].afterUtterance);
}
assert.deepEqual(d.evaluations.map(e => [e.from, e.to]), Array.from({ length: 12 }, (_, i) => [i * 10 + 1, i * 10 + 10]));
assert.ok(d.evaluations.every(e => e.status === 'completed' && !e.contextTruncated));
const records = (await readFile(join(root, 'records.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
assert.equal(records.filter(r => r.type === 'invocation').reduce((sum, c) => sum + c.usage.totalTokens, 0), d.summary.tokens.totalTokens);
assert.ok(!records.some(r => r.type === 'raw_event' && r.method === 'item/started' && ['commandExecution', 'mcpToolCall', 'webSearch', 'collabToolCall', 'fileChange'].includes(r.params?.item?.type)));
assert.equal(createHash('sha256').update(await readFile(join(root, 'source-experiment.json'))).digest('hex'), manifest.sourceSha256);
const distribution = (field: 'durationMs' | 'firstOutputMs' | 'queueMs') => {
  const values = calls.flatMap(c => c[field] === null ? [] : [c[field]!]).toSorted((a, b) => a - b);
  return { measured: values.length, meanMs: values.reduce((sum, n) => sum + n, 0) / values.length,
    medianMs: values[Math.ceil(values.length / 2) - 1], p95Ms: values[Math.ceil(values.length * .95) - 1] };
};
const findings = d.findings.map(f => ({ ...f, speechIndex: speeches.find(u => u.id === f.utteranceId)?.speechIndex, speakerName: speeches.find(u => u.id === f.utteranceId)?.speakerName }));
const issues = findings.filter(f => f.verdict === 'issue' && f.review !== 'dismissed');
const categories = Object.fromEntries([...new Set(findings.map(f => f.category))].map(category => [category, { issue: issues.filter(f => f.category === category).length, uncertain: findings.filter(f => f.category === category && f.verdict === 'uncertain').length }]));
const analysis = { experimentId: d.run.experimentId, runId: d.run.id, sourceSha256: manifest.sourceSha256, snapshotHash: d.run.snapshotHash,
  model: 'gpt-6.1-terra', effort: 'medium', speeches: 120, events: 3,
  summary: d.summary, publicGeneration: distribution('durationMs'), publicFirstOutput: distribution('firstOutputMs'), publicQueue: distribution('queueMs'),
  categories, findings, compactions: d.invocations.reduce((sum, c) => sum + Number(c.metadata.compactions ?? 0), 0),
  failedAttempts: d.invocations.filter(c => c.status !== 'completed').map(c => ({ id: c.id, operationKey: c.operationKey, error: c.error, usage: c.usage, durationMs: c.durationMs })),
  perCharacter: d.run.spec.scenario.characters.map(c => ({ id: c.id, name: c.name, speeches: speeches.filter(u => u.speakerId === c.id).length, issues: issues.filter(f => f.speakerName === c.name).length })),
  verified: { sourceSnapshot: true, requestedModels: true, exactlyOneRun: true, receiptOrder: true, noDuplicateInput: true, privateInitialProfiles: true, noFutureEventsInPersona: true, noTools: true, evaluationCoverage: 120, jsonlTokenTotal: true } };
await writeFile(join(root, 'analysis.json'), JSON.stringify(analysis, null, 2));
await writeFile(join(root, 'review-transcript.txt'), d.utterances.map(u => `${u.kind === 'speech' ? `#${u.speechIndex}` : '[공식 사건]'} ${u.speakerName}\n${u.speech}\n[행동] ${u.action}\n`).join('\n'));
console.log(JSON.stringify({ ...analysis, findings: findings.map(f => ({ n: f.speechIndex, category: f.category, severity: f.severity, verdict: f.verdict, quote: f.quote })), summary: { tokens: d.summary.tokens, elapsedMs: d.summary.elapsedMs, quality: d.summary.quality } }, null, 2));
