import { createInterface } from 'node:readline';
if (process.argv.includes('--version')) { console.log('codex-protocol-fixture'); process.exit(0); }
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
let count = 0;
const turns = [];
const threads = new Map();
const fail = (m, message) => send({ id: m.id, error: { code: -32600, message } });
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line), p = m.params;
  if (m.method === 'initialize') send({ id: m.id, result: {} });
  else if (m.method === 'config/read') send({ id: m.id, result: { config: {} } });
  else if (m.method === 'model/list') send({ id: m.id, result: { data: [{ model: 'fixture', displayName: 'Fixture', supportedReasoningEfforts: [{ reasoningEffort: 'low' }], defaultReasoningEffort: 'low', isDefault: true }], nextCursor: null } });
  else if (m.method === 'thread/start') {
    if (/director$/.test(p.cwd) && [...threads.values()].some(t => t.cwd === p.cwd)) return fail(m, 'Previous director session was not deleted');
    const thread = { id: `thread-${++count}`, cwd: p.cwd, ephemeral: false }; threads.set(thread.id, thread);
    send({ id: m.id, result: { thread } });
  }
  else if (m.method === 'thread/read' || m.method === 'thread/resume') {
    if (!threads.has(p.threadId)) return fail(m, m.method === 'thread/read' ? `thread not loaded: ${p.threadId}` : `no rollout found for thread id ${p.threadId}`);
    send({ id: m.id, result: { thread: threads.get(p.threadId) } });
  }
  else if (m.method === 'thread/delete') { threads.delete(p.threadId); send({ id: m.id, result: {} }); }
  else if (m.method === 'thread/turns/list') send({ id: m.id, result: { data: turns.filter(t => t.threadId === p.threadId).map(t => ({ id: t.id, status: 'completed', items: [] })), nextCursor: null } });
  else if (m.method === 'thread/items/list') send({ id: m.id, result: { data: turns.filter(t => t.threadId === p.threadId && (!p.turnId || t.id === p.turnId)).flatMap(t => [
    { turnId: t.id, item: { type: 'userMessage', id: `input-${t.id}`, clientId: t.clientId, content: [] } },
    { turnId: t.id, item: { type: 'agentMessage', id: `output-${t.id}`, text: t.output } }
  ]), nextCursor: null } });
  else if (m.method === 'turn/start') {
    const turnId = `turn-${++count}`; send({ id: m.id, result: { turn: { id: turnId } } });
    const input = JSON.parse(p.input[0].text);
    const output = JSON.stringify(input.task === 'direct' ? { speakerId: input.allowedSpeakerIds[0], reason: '순서 선택' } : { speech: '안녕하세요', action: '고개를 끄덕인다' });
    turns.push({ id: turnId, threadId: p.threadId, clientId: p.clientUserMessageId, output });
    send({ method: 'turn/started', params: { threadId: p.threadId, turn: { id: turnId } } });
    send({ method: 'item/agentMessage/delta', params: { threadId: p.threadId, turnId, delta: output } });
    send({ method: 'item/completed', params: { threadId: p.threadId, turnId, item: { id: `item-${count}`, type: 'agentMessage', text: output } } });
    send({ method: 'turn/completed', params: { threadId: p.threadId, turn: { id: turnId, status: 'completed' } } });
    setTimeout(() => send({ method: 'thread/tokenUsage/updated', params: { threadId: p.threadId, turnId, tokenUsage: { total: { inputTokens: 100, cachedInputTokens: 20, cacheWriteInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 4, totalTokens: 120 } } } }), 60);
  }
});
