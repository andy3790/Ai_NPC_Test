import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const model = 'gpt-6-luna';

// Local transport only: validates credentials and response chains without network or billing.
export function openaiFixture() {
  const key = 'fixture-only-' + randomUUID();
  const acceptedKeys = new Set([key]), responseKeys = new Map<string, string>();
  const authorizations: { url: string; key: string; body?: any }[] = [];
  const requests: any[] = [], retrieved: string[] = [], responses = new Map<string, any>();
  let next = '', counter = 0;
  const fake: typeof fetch = async (url, init) => {
    assert.ok(String(url).startsWith('https://api.openai.com/v1/'));
    const requestKey = String((init?.headers as any).Authorization).replace(/^Bearer /, '');
    authorizations.push({ url: String(url), key: requestKey, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    assert.equal(init?.redirect, 'error');
    if (!acceptedKeys.has(requestKey)) return Response.json({ error: { message: `invalid fixture key ${requestKey}` } }, { status: 401 });
    if (String(url).endsWith('/models')) return Response.json({ data: [{ id: model }, { id: 'gpt-4.1-mini' }, { id: 'embedding-not-for-dialogue' }] });
    if (init?.method !== 'POST') {
      const id = String(url).split('/').at(-1)!; retrieved.push(id);
      return responses.has(id) && responseKeys.get(id) === requestKey ? Response.json(responses.get(id)) : new Response('', { status: 404 });
    }
    const body = JSON.parse(String(init.body)); requests.push(body);
    const failure = next; next = '';
    if (failure === 'rate') return Response.json({ error: { code: 'insufficient_quota', message: `fixture echo ${requestKey}` } }, { status: 429 });
    if (failure === 'bad_json') return new Response(`data: {malformed ${requestKey}\n\n`);
    if (failure === 'server') return new Response('server error', { status: 503 });
    const input = JSON.parse(body.input), id = `mock-response-${++counter}`;
    let output: any = input.task === 'environment' ? { elapsedSeconds: 2, facts: [], forgetFactIds: [], processes: [], finishProcesses: [], events: [] } : input.task === 'receive' ? { received: true } : input.task === 'evaluate' ? { findings: [], summary: '검사 완료' } : input.task === 'direct' ? { speakerId: input.allowedSpeakerIds[0], reason: '순서 선택' } : { speech: '안녕하세요. 다음 선택을 이야기해요.', action: '고개를 끄덕인다.' };
    if (input.task === 'speak' && input.localContext) output = { ...output, communication: { mode: 'local', targetNpcIds: [], channelId: null }, moveToLocationId: null, activityChoice: input.localContext.ongoingActivity ? 'continue' : 'start' };
    if (input.task === 'spatial_plan') output = { plans: input.choices.map((u: any) => ({ utteranceId: u.id, speechSeconds: 1, actionSeconds: 2, reactionNpcIds: [], movementStarts: false })) };
    if (input.task === 'event_generation') output = { proposal: { title: '경고음', description: '휴게실에서 짧은 경고음이 들린다.', locationIds: ['lounge'], severity: 'low' } };
    if (input.task === 'spatial_resolve') output = { completedActivities: input.dueActivityIds.map((id: string) => ({ id, outcome: 'completed', reason: '완료' })), activityUpdates: [], movements: [], facts: [], forgetFactIds: [], processes: [], finishProcesses: [],
      events: input.proposal ? [{ type: 'external_signal', text: input.proposal.description, npcId: null, evidence: null, processId: null, sourceUtteranceId: null, proposalId: input.proposal.id, audience: { scope: 'locations', locationIds: ['lounge'], npcIds: [] } }] : [], proposalDecision: input.proposal ? { accepted: true, reason: '기존 세계 안의 징후' } : null };
    const usage = { input_tokens: 100, input_tokens_details: { cached_tokens: 60, cache_write_tokens: 10 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 5 }, total_tokens: 120 };
    const completed = { id, status: 'completed', model: body.model, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(output) }] }], ...(failure === 'missing_usage' ? {} : { usage }) };
    responses.set(id, completed); responseKeys.set(id, requestKey);
    const terminal = failure === 'incomplete' ? { ...completed, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } : completed;
    const events = [
      ...(failure === 'unknown' ? [] : [{ type: 'response.created', response: { id, model: body.model, status: 'in_progress' } }]),
      ...(['drop', 'unknown'].includes(failure) ? [] : [
        { type: 'response.output_text.delta', delta: JSON.stringify(output) },
        { type: failure === 'incomplete' ? 'response.incomplete' : 'response.completed', response: terminal },
      ]),
    ];
    // Split Korean UTF-8 and CRLF SSE frames to exercise streaming decode.
    const bytes = new TextEncoder().encode(events.map(event => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join(''));
    return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 13) controller.enqueue(bytes.slice(i, i + 13)); controller.close(); } }), { headers: { 'Content-Type': 'text/event-stream', 'x-request-id': 'req_fixture' } });
  };
  return { key, acceptedKeys, authorizations, requests, retrieved, responses, fetch: fake, fail(mode: string) { next = mode; } };
}
