import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Adapter, AdapterEvent, TurnRequest, TurnResult } from './types.js';
import type { ModelConfig } from '../shared/schema.js';
import type { ModelInfo, TokenUsage } from '../shared/types.js';
import { baseInstructions } from '../core/prompts.js';
import { normalizeUsage, tokenKeys } from '../core/metrics.js';

export function codexCommand(): { command: string; prefix: string[] } {
  if (process.env.CODEX_BIN) {
    const bin = resolve(process.env.CODEX_BIN);
    if (!existsSync(bin)) throw new Error(`CODEX_BIN 파일이 없습니다: ${bin}`);
    if (/\.([cm]?js)$/i.test(bin)) return { command: process.execPath, prefix: [bin] };
    if (/\.(cmd|ps1|bat)$/i.test(bin)) throw new Error('CODEX_BIN에는 codex.exe 또는 codex.js 경로를 지정하세요.');
    return { command: bin, prefix: [] };
  }
  if (process.platform === 'win32') {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const target = arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
    const native = join(process.env.APPDATA ?? '', `npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-${arch}/vendor/${target}/bin/codex.exe`);
    if (existsSync(native)) return { command: native, prefix: [] };
    const js = join(process.env.APPDATA ?? '', 'npm/node_modules/@openai/codex/bin/codex.js');
    if (existsSync(js)) return { command: process.execPath, prefix: [js] };
  }
  return { command: 'codex', prefix: [] };
}
export class CodexAdapter implements Adapter {
  name = 'codex'; version = 'unknown';
  private child?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private active = new Map<string, { emit: (e: AdapterEvent) => void; finish: (r: TurnResult) => void; turnId: string | null; output: string; items: Map<string, string> }>();
  private totals = new Map<string, TokenUsage>();
  private usageTurn = new Map<string, string>();
  private finishedTurn = new Map<string, string>();
  private observers = new Map<string, (e: AdapterEvent) => void>();
  private resumed = new Set<string>();
  private overrides: Record<string, unknown> = {};
  diagnostics: string[] = [];
  constructor(private root: string) {}
  private async start() {
    if (this.ready) return this.ready;
    this.ready = this.startProcess().catch(e => { this.ready = undefined; throw e; });
    return this.ready;
  }
  private async startProcess() {
    mkdirSync(this.root, { recursive: true });
    const { command, prefix } = codexCommand();
    const version = spawnSync(command, [...prefix, '--version'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    if (version.error) throw new Error(`Codex 실행 실패: ${version.error.message}`);
    this.version = version.stdout.trim();
    const fixed: Record<string, unknown> = {
      'features.shell_tool': false, 'features.apps': false, 'features.goals': false,
      'features.multi_agent': false, 'features.js_repl': false, 'features.code_mode.enabled': false,
      'web_search': 'disabled', 'project_doc_max_bytes': 0, 'developer_instructions': '',
    };
    this.overrides = { ...fixed };
    const args = [...prefix, 'app-server', '--listen', 'stdio://'];
    for (const [key, value] of Object.entries(fixed)) args.push('-c', `${key}=${JSON.stringify(value)}`);
    this.child = spawn(command, args, { cwd: this.root, windowsHide: true, stdio: 'pipe' });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (s: string) => { this.diagnostics.push(s.slice(0, 4000)); this.diagnostics = this.diagnostics.slice(-20); });
    const died = (message: string) => {
      for (const p of this.pending.values()) p.reject(new Error(message)); this.pending.clear();
      for (const a of this.active.values()) a.finish({ turnId: a.turnId ?? '', output: a.output, status: 'uncertain', error: message });
      this.active.clear(); this.resumed.clear(); this.totals.clear(); this.usageTurn.clear(); this.finishedTurn.clear(); this.observers.clear(); this.ready = undefined;
    };
    this.child.on('error', e => died(e.message));
    this.child.on('exit', code => died(`Codex app-server 종료 (${code}). ${this.diagnostics.slice(-1).join('')}`));
    createInterface({ input: this.child.stdout }).on('line', line => {
      try { this.message(JSON.parse(line)); } catch (e) { this.diagnostics.push(`프로토콜 이벤트 오류: ${String(e)}`); }
    });
    await this.rpc('initialize', { clientInfo: { name: 'npc_dialogue_lab', title: 'NPC Dialogue Lab', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    this.send({ method: 'initialized', params: {} });
    const { config } = await this.rpc('config/read', { includeLayers: false });
    for (const name of Object.keys(config.mcp_servers ?? {})) this.overrides[`mcp_servers.${name}.enabled`] = false;
    for (const name of Object.keys(config.plugins ?? {})) this.overrides[`plugins.${name}.enabled`] = false;
    for (const name of Object.keys(config.hooks ?? {})) this.overrides[`hooks.${name}`] = [];
    if (config.skills?.config) this.overrides['skills.config'] = config.skills.config.map((x: any) => ({ ...x, enabled: false }));
  }
  private send(value: unknown) { if (!this.child?.stdin.writable) throw new Error('Codex 연결이 닫혔습니다.'); this.child.stdin.write(JSON.stringify(value) + '\n'); }
  private rpc(method: string, params: unknown, timeout = 30_000): Promise<any> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} 요청 시간 초과`)); }, timeout);
      this.pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
      try { this.send({ id, method, params }); } catch (e) { this.pending.get(id)?.reject(e as Error); this.pending.delete(id); }
    });
  }
  private message(message: any) {
    if (message.id !== undefined && !message.method) {
      const p = this.pending.get(message.id); if (!p) return; this.pending.delete(message.id);
      message.error ? p.reject(new Error(JSON.stringify(message.error))) : p.resolve(message.result); return;
    }
    if (message.id !== undefined && message.method) {
      const result = /requestApproval/i.test(message.method) ? { decision: 'decline' } : undefined;
      this.send(result ? { id: message.id, result } : { id: message.id, error: { code: -32601, message: 'NPC simulation does not permit tool or user-input requests' } });
    }
    const p = message.params ?? {}; const threadId = p.threadId ?? p.thread?.id;
    const a = this.active.get(threadId);
    if (message.method === 'thread/tokenUsage/updated') {
      if ((a && (!a.turnId || a.turnId === p.turnId)) || (!a && this.finishedTurn.get(threadId) === p.turnId)) {
        this.totals.set(threadId, normalizeUsage(p.tokenUsage.total)); this.usageTurn.set(threadId, p.turnId);
      }
      if ((!a || (a.turnId && a.turnId !== p.turnId)) && this.observers.has(p.turnId)) { this.observers.get(p.turnId)!({ method: message.method, params: p }); return; }
    }
    if (!a) return;
    if (message.method === 'turn/started') { a.turnId = p.turn.id; this.observers.set(p.turn.id, a.emit); }
    // Ignore unrelated late events from older turns, but retain metadata for this turn.
    if (p.turnId && a.turnId && p.turnId !== a.turnId) return;
    a.emit({ method: message.method, params: p });
    if (message.method === 'item/agentMessage/delta') a.output += p.delta;
    if (message.method === 'item/completed' && p.item?.type === 'agentMessage') a.items.set(p.item.id, p.item.text);
    if (message.method === 'turn/completed') {
      this.finishedTurn.set(threadId, p.turn.id); this.observers.set(p.turn.id, a.emit);
      if (this.observers.size > 5000) this.observers.delete(this.observers.keys().next().value!);
      const messages = [...a.items.values()]; const output = messages.at(-1) ?? a.output;
      a.finish({ turnId: p.turn.id, output, status: p.turn.status === 'completed' ? 'completed' : p.turn.status === 'interrupted' ? 'cancelled' : 'failed', error: p.turn.error ? JSON.stringify(p.turn.error) : undefined });
    }
  }
  async models(): Promise<ModelInfo[]> {
    await this.start(); const result: ModelInfo[] = []; let cursor: string | null = null;
    do {
      const page = await this.rpc('model/list', { limit: 100, includeHidden: false, cursor });
      result.push(...page.data.map((x: any) => ({ id: x.model, name: x.displayName, efforts: x.supportedReasoningEfforts.map((e: any) => e.reasoningEffort), defaultEffort: x.defaultReasoningEffort, isDefault: x.isDefault })));
      cursor = page.nextCursor;
    } while (cursor);
    return result;
  }
  async createSession(config: ModelConfig, instructions: string, cwd: string) {
    await this.start(); mkdirSync(cwd, { recursive: true });
    const result = await this.rpc('thread/start', { model: config.model, cwd, approvalPolicy: 'never', sandbox: 'read-only',
      baseInstructions, developerInstructions: instructions, config: this.overrides, environments: [],
      ephemeral: false, serviceName: 'npc-dialogue-lab', allowProviderModelFallback: false,
    });
    const id = result.thread.id; this.resumed.add(id);
    this.totals.set(id, Object.fromEntries(tokenKeys.map(k => [k, 0])) as unknown as TokenUsage);
    return id;
  }
  async resumeSession(threadId: string) {
    await this.start(); if (this.resumed.has(threadId)) return;
    await this.rpc('thread/resume', { threadId, excludeTurns: true, config: this.overrides, approvalPolicy: 'never', sandbox: 'read-only' });
    this.resumed.add(threadId);
  }
  baseline(threadId: string) {
    const finished = this.finishedTurn.get(threadId);
    if (finished && this.usageTurn.get(threadId) !== finished) return null;
    return this.totals.get(threadId) ?? null;
  }
  async turn(request: TurnRequest, emit: (event: AdapterEvent) => void, signal?: AbortSignal): Promise<TurnResult> {
    await this.resumeSession(request.threadId);
    if (this.active.has(request.threadId)) throw new Error('동일 세션에 중복 요청이 발생했습니다.');
    return new Promise(resolve => {
      let finished = false; let grace: ReturnType<typeof setTimeout> | undefined;
      const finish = (r: TurnResult) => { if (finished) return; finished = true; clearTimeout(timer); clearTimeout(grace); signal?.removeEventListener('abort', abort); this.active.delete(request.threadId); resolve(r); };
      const abort = () => {
        const a = this.active.get(request.threadId);
        if (a?.turnId) void this.rpc('turn/interrupt', { threadId: request.threadId, turnId: a.turnId }).catch(() => {});
        grace = setTimeout(() => finish({ turnId: a?.turnId ?? '', output: a?.output ?? '', status: 'uncertain', error: '중단 요청 후 완료 상태를 확인하지 못했습니다.' }), 5000);
      };
      const timer = setTimeout(abort, request.timeoutMs);
      this.active.set(request.threadId, { emit, finish, turnId: null, output: '', items: new Map() });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { finish({ turnId: '', output: '', status: 'cancelled', error: '요청 전 취소' }); return; }
      void this.rpc('turn/start', { threadId: request.threadId, input: [{ type: 'text', text: request.input }],
        model: request.config.model, effort: request.config.effort, outputSchema: request.outputSchema, clientUserMessageId: request.clientMessageId,
        approvalPolicy: 'never', environments: [],
      }).then(r => { const a = this.active.get(request.threadId); if (a) { a.turnId = r.turn.id; emit({ method: 'turn/accepted', params: { threadId: request.threadId, turnId: r.turn.id } }); } })
        .catch(e => finish({ turnId: this.active.get(request.threadId)?.turnId ?? '', output: '', status: 'uncertain', error: e.message }));
    });
  }
  async reconcile(threadId: string, turnId: string | null, clientMessageId: string): Promise<TurnResult | null> {
    await this.resumeSession(threadId);
    if (!turnId) {
      let itemCursor: string | null = null;
      do {
        const page = await this.rpc('thread/items/list', { threadId, cursor: itemCursor, sortDirection: 'desc', limit: 100 });
        const match = page.data.find((entry: any) => entry.item?.type === 'userMessage' && entry.item.clientId === clientMessageId);
        if (match) { turnId = match.turnId; break; }
        itemCursor = page.nextCursor;
      } while (itemCursor);
      if (!turnId) return null;
    }
    let cursor: string | null = null;
    do {
      const page = await this.rpc('thread/turns/list', { threadId, cursor, limit: 100 });
      const turn = page.data.find((x: any) => x.id === turnId);
      if (turn) {
        if (!['completed', 'failed', 'interrupted'].includes(turn.status)) return null;
        const items: any[] = []; let itemCursor: string | null = null;
        do { const p = await this.rpc('thread/items/list', { threadId, turnId, cursor: itemCursor, sortDirection: 'asc', limit: 100 }); items.push(...p.data.map((entry: any) => entry.item)); itemCursor = p.nextCursor; } while (itemCursor);
        return { turnId, output: items.filter(x => x.type === 'agentMessage').at(-1)?.text ?? '', status: turn.status === 'completed' ? 'completed' : turn.status === 'interrupted' ? 'cancelled' : 'failed', error: turn.error ? JSON.stringify(turn.error) : undefined };
      }
      cursor = page.nextCursor;
    } while (cursor);
    return null;
  }
  async close() {
    const child = this.child; if (!child) return;
    await new Promise<void>(resolve => {
      if (child.exitCode !== null) { resolve(); return; }
      const timer = setTimeout(() => { child.kill(); resolve(); }, 5000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.stdin.end();
    });
    this.child = undefined;
  }
}
