import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { Adapter, AdapterEvent, TurnRequest, TurnResult } from './types.js';
import type { ModelConfig } from '../shared/schema.js';
import type { ModelInfo, TokenUsage } from '../shared/types.js';
import { baseInstructions } from '../core/prompts.js';
import { normalizeUsage } from '../core/metrics.js';

const profileSchema = z.object({ id: z.string().min(1), name: z.string().optional(), efforts: z.array(z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])).min(1), defaultEffort: z.string(), reasoning: z.boolean().default(true) });
type Profile = { id: string; name?: string; efforts: string[]; defaultEffort: string; reasoning: boolean };
const thinking = ['low', 'medium', 'high', 'xhigh', 'max'];
// /models lists account access, not reasoning capabilities. Keep a documented
// capability table, overridable for additional Responses-compatible models.
const builtins: Profile[] = [
  { id: 'gpt-6-luna', efforts: ['none', ...thinking], defaultEffort: 'low', reasoning: true },
  { id: 'gpt-6.1-terra', efforts: ['none', ...thinking], defaultEffort: 'low', reasoning: true },
  { id: 'gpt-6.1-sol', efforts: thinking, defaultEffort: 'low', reasoning: true },
  { id: 'gpt-6-astra', efforts: thinking, defaultEffort: 'low', reasoning: true },
  { id: 'gpt-6-sol', efforts: ['none', ...thinking], defaultEffort: 'low', reasoning: true },
  { id: 'gpt-4.1-mini', efforts: ['none'], defaultEffort: 'none', reasoning: false },
];
interface Session { id: string; config: ModelConfig; instructions: string; previousResponseId: string | null; maxOutputTokens: number; reasoning: boolean }
interface Attempt { threadId: string; clientMessageId: string; previousResponseId: string | null; responseId: string | null; result?: TurnResult }
interface Options { apiKey?: string; fetch?: typeof globalThis.fetch; profiles?: Profile[]; maxOutputTokens?: number }

export function responseUsage(raw: any): TokenUsage {
  return normalizeUsage({ inputTokens: raw?.input_tokens, cachedInputTokens: raw?.input_tokens_details?.cached_tokens,
    cacheWriteInputTokens: raw?.input_tokens_details?.cache_write_tokens,
    outputTokens: raw?.output_tokens, reasoningOutputTokens: raw?.output_tokens_details?.reasoning_tokens, totalTokens: raw?.total_tokens });
}

// Normalize Zod's dialect marker and literal keyword to the API's documented
// Structured Outputs subset without changing the validation contract.
export function responseSchema(value: any): any {
  if (Array.isArray(value)) return value.map(responseSchema);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== '$schema').map(([key, child]) => key === 'const' ? ['enum', [child]] : [key, responseSchema(child)]));
}

export class OpenAIAdapter implements Adapter {
  name = 'openai'; version = 'responses-http/1';
  private readonly apiKey: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly profiles: Profile[];
  private readonly maxOutputTokens: number;
  private active = new Map<string, AbortController>();
  private root: string;
  constructor(directory: string, options: Options = {}) {
    this.apiKey = (options.apiKey ?? process.env.OPENAI_API_KEY ?? '').trim();
    if (!this.apiKey) throw new Error('OpenAI API 실행에는 OPENAI_API_KEY 환경 변수 또는 .env 설정이 필요합니다.');
    this.fetcher = options.fetch ?? globalThis.fetch;
    const custom = options.profiles ?? (process.env.NPC_OPENAI_MODELS ? JSON.parse(process.env.NPC_OPENAI_MODELS) : []);
    const parsed = z.array(profileSchema).parse(custom);
    this.profiles = [...builtins.filter(p => !parsed.some(x => x.id === p.id)), ...parsed];
    for (const p of this.profiles) if (!p.efforts.includes(p.defaultEffort) || (!p.reasoning && p.efforts.some(e => e !== 'none'))) throw new Error(`잘못된 API 모델 설정: ${p.id}`);
    this.maxOutputTokens = Number(options.maxOutputTokens ?? process.env.OPENAI_MAX_OUTPUT_TOKENS ?? 4096);
    if (!Number.isSafeInteger(this.maxOutputTokens) || this.maxOutputTokens < 256 || this.maxOutputTokens > 128000) throw new Error('OPENAI_MAX_OUTPUT_TOKENS는 256~128000의 정수여야 합니다.');
    this.root = resolve(directory, 'openai');
    mkdirSync(join(this.root, 'sessions'), { recursive: true }); mkdirSync(join(this.root, 'calls'), { recursive: true });
  }
  private file(kind: 'sessions' | 'calls', id: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('잘못된 API 기록 ID');
    return join(this.root, kind, id + '.json');
  }
  private load<T>(kind: 'sessions' | 'calls', id: string): T { return JSON.parse(readFileSync(this.file(kind, id), 'utf8')); }
  private save(kind: 'sessions' | 'calls', id: string, value: unknown) {
    const file = this.file(kind, id), temporary = file + '.tmp';
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 }); renameSync(temporary, file);
  }
  private clean(value: any): any {
    return JSON.parse(JSON.stringify(value, (_key, v) => typeof v === 'string' ? v.split(this.apiKey).join('[REDACTED]') : v));
  }
  private async request(path: string, init: RequestInit = {}) {
    // Fixed official origin; keys cannot be redirected to a configurable proxy.
    const response = await this.fetcher(`https://api.openai.com/v1${path}`, {
      ...init, redirect: 'error', headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', ...init.headers },
    });
    return response;
  }
  async models(): Promise<ModelInfo[]> {
    const response = await this.request('/models', { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`OpenAI 모델 조회 실패 (HTTP ${response.status}). 키·프로젝트 권한을 확인하세요.`);
    const data = await response.json() as { data: { id: string }[] };
    const available = this.profiles.filter(p => data.data.some(m => m.id === p.id));
    if (!available.length) throw new Error('계정의 모델 목록과 API 지원표가 일치하지 않습니다. NPC_OPENAI_MODELS 설정을 확인하세요.');
    return available.map((p, index) => ({ id: p.id, name: p.name ?? p.id, efforts: p.efforts, defaultEffort: p.defaultEffort, isDefault: index === 0 }));
  }
  async createSession(config: ModelConfig, instructions: string, _cwd: string) {
    const profile = this.profiles.find(p => p.id === config.model);
    if (!profile?.efforts.includes(config.effort)) throw new Error('지원되지 않는 API 모델·추론 조합');
    const id = randomUUID(); this.save('sessions', id, { id, config, instructions, previousResponseId: null, maxOutputTokens: this.maxOutputTokens, reasoning: profile.reasoning } satisfies Session); return id;
  }
  async resumeSession(id: string) { this.load<Session>('sessions', id); }
  baseline(_threadId: string): TokenUsage | null { return null; }
  private commitResponse(attempt: Attempt, response: any): TurnResult {
    if (!response.id || (attempt.responseId && response.id !== attempt.responseId)) throw new Error('API 응답 ID 불일치');
    const output = (response.output ?? []).filter((item: any) => item.type === 'message' && item.role === 'assistant')
      .flatMap((item: any) => item.content ?? []).filter((part: any) => part.type === 'output_text').map((part: any) => part.text).join('');
    const completed = response.status === 'completed';
    const result: TurnResult = { turnId: response.id, output, status: completed ? 'completed' : response.status === 'cancelled' ? 'cancelled' : 'failed',
      inputRetained: completed, actualModel: response.model, ...(response.usage ? { usage: responseUsage(response.usage), rawUsage: response.usage } : {}),
      ...(!completed ? { error: JSON.stringify(response.error ?? response.incomplete_details ?? { status: response.status }) } : {}),
    };
    // Only successful Responses form the next context link. Incomplete/failed
    // responses are measured, but a retry must retain the original input.
    if (completed) {
      const session = this.load<Session>('sessions', attempt.threadId);
      if (![attempt.previousResponseId, response.id].includes(session.previousResponseId)) throw new Error('API 세션의 응답 연결이 변경되었습니다.');
      session.previousResponseId = response.id; this.save('sessions', session.id, session);
    }
    attempt.responseId = response.id; attempt.result = result; this.save('calls', attempt.clientMessageId, attempt);
    return result;
  }
  async turn(r: TurnRequest, emit: (event: AdapterEvent) => void, signal?: AbortSignal): Promise<TurnResult> {
    if (this.active.has(r.threadId)) throw new Error('동일 API 세션에 중복 요청이 발생했습니다.');
    const session = this.load<Session>('sessions', r.threadId);
    if (session.config.model !== r.config.model || session.config.effort !== r.config.effort) throw new Error('실행 중 API 세션의 모델·추론 강도를 변경할 수 없습니다.');
    const profile = this.profiles.find(p => p.id === r.config.model);
    if (!profile?.efforts.includes(r.config.effort)) throw new Error('지원되지 않는 API 모델·추론 조합');
    if (existsSync(this.file('calls', r.clientMessageId))) throw new Error('기록된 API 호출을 다시 전송하지 않습니다. 먼저 완료 상태를 대조하세요.');
    const controller = new AbortController(); this.active.set(r.threadId, controller);
    const combined = AbortSignal.any([controller.signal, AbortSignal.timeout(r.timeoutMs), ...(signal ? [signal] : [])]);
    const attempt: Attempt = { threadId: r.threadId, clientMessageId: r.clientMessageId, previousResponseId: session.previousResponseId, responseId: null };
    let sent = false, delta = '';
    try {
      if (combined.aborted) return { turnId: '', output: '', status: 'cancelled', inputRetained: false, error: '요청 전 취소' };
      this.save('calls', r.clientMessageId, attempt);
      const body = { model: r.config.model, ...(session.reasoning ? { reasoning: { effort: r.config.effort } } : {}),
        // Instructions are not inherited by previous_response_id. Resending this
        // field preserves the session persona; speech-only reminders stay in input.
        instructions: baseInstructions + '\n' + session.instructions, input: r.input,
        previous_response_id: session.previousResponseId, store: true, stream: true, tools: [], tool_choice: 'none',
        truncation: 'disabled', max_output_tokens: session.maxOutputTokens,
        metadata: { npc_lab_call_id: r.clientMessageId, npc_lab_session_id: r.threadId },
        text: { format: { type: 'json_schema', name: 'npc_lab_output', strict: true, schema: responseSchema(r.outputSchema) } },
      };
      emit({ method: 'openai/request', params: { body, transportVersion: this.version } });
      sent = true;
      const response = await this.request('/responses', { method: 'POST', body: JSON.stringify(body), signal: combined });
      emit({ method: 'openai/http', params: { status: response.status, requestId: response.headers.get('x-request-id') } });
      if (!response.ok) {
        let detail: any; try { detail = this.clean(await response.json()); } catch { detail = { error: { message: '응답 본문 없음' } }; }
        const result: TurnResult = { turnId: '', output: '', status: response.status >= 500 ? 'uncertain' : 'failed', inputRetained: false, error: `OpenAI HTTP ${response.status}: ${JSON.stringify(detail.error ?? detail)}` };
        attempt.result = result; this.save('calls', r.clientMessageId, attempt); return result;
      }
      if (!response.body) throw new Error('API 응답 스트림이 없습니다.');
      let buffer = ''; const decoder = new TextDecoder(); const reader = response.body.getReader();
      try {
        for (;;) {
          const chunk = await reader.read(); buffer += decoder.decode(chunk.value, { stream: !chunk.done }); buffer = buffer.replace(/\r\n/g, '\n');
          let boundary: number;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (!data || data === '[DONE]') continue;
            const event = this.clean(JSON.parse(data));
            if (event.response?.id && !attempt.responseId) {
              attempt.responseId = event.response.id; this.save('calls', r.clientMessageId, attempt);
              emit({ method: 'turn/accepted', params: { threadId: r.threadId, turnId: attempt.responseId } });
            }
            emit({ method: `openai/${event.type}`, params: event });
            if (event.response?.model) emit({ method: 'model/resolved', params: { model: event.response.model } });
            if (event.type === 'response.output_text.delta') {
              delta += event.delta; emit({ method: 'item/agentMessage/delta', params: { threadId: r.threadId, turnId: attempt.responseId, delta: event.delta } });
            }
            if (['response.completed', 'response.failed', 'response.incomplete', 'response.cancelled'].includes(event.type)) {
              if (event.response.usage) emit({ method: 'response/usage', params: { usage: responseUsage(event.response.usage), raw: event.response.usage } });
              return this.commitResponse(attempt, event.response);
            }
            if (event.type === 'error') throw new Error(JSON.stringify(event));
          }
          if (chunk.done) break;
        }
      } finally { await reader.cancel().catch(() => {}); }
      throw new Error('API 스트림이 최종 응답 전에 종료되었습니다.');
    } catch (error) {
      const result: TurnResult = { turnId: attempt.responseId ?? '', output: delta, status: sent ? 'uncertain' : 'cancelled', inputRetained: false,
        error: this.clean(error instanceof Error ? error.message : String(error)) };
      // No automatic retry: after a network timeout the API may still be working.
      attempt.result = result; this.save('calls', r.clientMessageId, attempt); return result;
    } finally { this.active.delete(r.threadId); }
  }
  async reconcile(threadId: string, turnId: string | null, clientMessageId: string): Promise<TurnResult | null> {
    if (!existsSync(this.file('calls', clientMessageId))) return null;
    const attempt = this.load<Attempt>('calls', clientMessageId);
    if (attempt.threadId !== threadId || (turnId && turnId !== attempt.responseId)) throw new Error('API 호출과 세션 ID 불일치');
    if (attempt.result && attempt.result.status !== 'uncertain') return attempt.result;
    if (!attempt.responseId) return null;
    const response = await this.request(`/responses/${encodeURIComponent(attempt.responseId)}`, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) return null;
    const value = this.clean(await response.json());
    if (!['completed', 'failed', 'incomplete', 'cancelled'].includes(value.status)) return null;
    return this.commitResponse(attempt, value);
  }
  async close() { for (const controller of this.active.values()) controller.abort(); }
}
