import { createInterface } from 'node:readline';
if (process.argv.includes('--version')) { console.log('codex-protocol-fixture'); process.exit(0); }
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
let count = 0;
const turns = [];
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line), p = m.params;
  if (m.method === 'initialize') send({ id: m.id, result: {} });
  else if (m.method === 'config/read') send({ id: m.id, result: { config: {} } });
  else if (m.method === 'model/list') send({ id: m.id, result: { data: [{ model: 'fixture', displayName: 'Fixture', supportedReasoningEfforts: [{ reasoningEffort: 'low' }], defaultReasoningEffort: 'low', isDefault: true }], nextCursor: null } });
  else if (m.method === 'thread/start') send({ id: m.id, result: { thread: { id: `thread-${++count}` } } });
  else if (m.method === 'thread/resume') send({ id: m.id, result: {} });
  else if (m.method === 'thread/turns/list') send({ id: m.id, result: { data: turns.filter(t => t.threadId === p.threadId).map(t => ({ id: t.id, status: 'completed', items: [] })), nextCursor: null } });
  else if (m.method === 'thread/items/list') send({ id: m.id, result: { data: turns.filter(t => t.threadId === p.threadId && (!p.turnId || t.id === p.turnId)).flatMap(t => [
    { turnId: t.id, item: { type: 'userMessage', id: `input-${t.id}`, clientId: t.clientId, content: [] } },
    { turnId: t.id, item: { type: 'agentMessage', id: `output-${t.id}`, text: '{"speech":"안녕하세요","action":"고개를 끄덕인다"}' } }
  ]), nextCursor: null } });
  else if (m.method === 'turn/start') {
    const turnId = `turn-${++count}`; send({ id: m.id, result: { turn: { id: turnId } } });
    turns.push({ id: turnId, threadId: p.threadId, clientId: p.clientUserMessageId });
    send({ method: 'turn/started', params: { threadId: p.threadId, turn: { id: turnId } } });
    send({ method: 'item/agentMessage/delta', params: { threadId: p.threadId, turnId, delta: '{"speech":"안녕하세요","action":"고개를 끄덕인다"}' } });
    send({ method: 'item/completed', params: { threadId: p.threadId, turnId, item: { id: `item-${count}`, type: 'agentMessage', text: '{"speech":"안녕하세요","action":"고개를 끄덕인다"}' } } });
    send({ method: 'turn/completed', params: { threadId: p.threadId, turn: { id: turnId, status: 'completed' } } });
    setTimeout(() => send({ method: 'thread/tokenUsage/updated', params: { threadId: p.threadId, turnId, tokenUsage: { total: { inputTokens: 100, cachedInputTokens: 20, cacheWriteInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 4, totalTokens: 120 } } } }), 60);
  }
});
