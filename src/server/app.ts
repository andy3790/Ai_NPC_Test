import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { Engine } from '../core/engine.js';
import { exampleSpec } from '../shared/example.js';
import { experimentSchema } from '../shared/schema.js';
import { exportFiles, zipFiles } from '../core/export.js';
import { groupedMetrics } from '../core/metrics.js';
import { APP_VERSION } from '../shared/version.js';
import type { RunHistoryCatalog } from '../core/history.js';
import { RunDeletionService } from '../core/deletion.js';
import { runSnapshot } from '../shared/run-snapshot.js';
import { audienceSchema } from '../shared/spatial-schema.js';
import { OpenAIAdapter } from '../adapters/openai.js';

export async function createApp(engine: Engine, options: { history?: RunHistoryCatalog } = {}) {
  const app = Fastify({ logger: false, bodyLimit: 4 * 1024 * 1024 });
  const history = options.history;
  const deletion = new RunDeletionService(engine, history);
  const openai = engine.adapter instanceof OpenAIAdapter ? engine.adapter : undefined;
  const browserOwner = (req: FastifyRequest, reply?: FastifyReply) => {
    let cookie = req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith('npc_lab_browser='))?.slice('npc_lab_browser='.length);
    if (!cookie || !/^[a-f0-9]{64}$/.test(cookie)) {
      if (!reply) return undefined;
      cookie = randomBytes(32).toString('hex');
      // Persistent browser identity only. The cookie never contains the API key.
      reply.header('Set-Cookie', `npc_lab_browser=${cookie}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=31536000`);
    }
    return createHash('sha256').update('npc-lab-browser/v1\0' + cookie).digest('hex');
  };
  const credential = (req: FastifyRequest) => openai?.keys.selection(browserOwner(req));
  const keyAdapter = () => { if (!openai) throw new Error('개인 API 키 설정은 OpenAI API 서버에서 사용하세요.'); return openai; };
  const keysChanged = () => engine.emit('change', { type: 'credentials-changed', runId: '', at: new Date().toISOString() });
  const detail = (id: string) => history ? history.detail(id) : engine.detail(id);
  const files = (id: string) => history ? history.exports(id) : exportFiles(engine.detail(id), engine.store.events(id));
  // Loopback binding plus Origin/Host checks prevent browser-driven writes from other sites.
  app.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host ?? '';
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)) return reply.code(403).send({ error: '로컬 연결만 허용합니다.' });
    const origin = request.headers.origin;
    if (origin && origin !== `http://${host}`) return reply.code(403).send({ error: '다른 출처의 요청은 허용하지 않습니다.' });
  });
  app.setErrorHandler((error, _request, reply) => {
    const message = error instanceof Error ? error.message : String(error);
    return reply.code(400).send({ error: openai ? openai.keys.redact(message) : message });
  });
  app.get('/api/health', async () => ({ ok: true, adapter: engine.adapter.name, version: APP_VERSION, historyEnabled: !!history }));
  app.get('/api/openai/key', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return keyAdapter().keys.status(browserOwner(req, reply));
  });
  app.put('/api/openai/key', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const adapter = keyAdapter();
    const { apiKey } = z.object({ apiKey: z.string().max(4096) }).strict().parse(req.body);
    const result = await adapter.setBrowserKey(browserOwner(req, reply)!, apiKey);
    keysChanged(); return result;
  });
  app.delete('/api/openai/key', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const adapter = keyAdapter(), owner = browserOwner(req, reply)!;
    adapter.keys.clearSelection(owner); keysChanged(); return adapter.keys.status(owner);
  });
  app.get('/api/history', async () => history ? { enabled: true, ...history.sources() } : { enabled: false, sources: [], runs: 0, errors: [] });
  app.post('/api/history/refresh', async () => { if (!history) throw new Error('이 서버는 통합 기록 조회가 꺼져 있습니다.'); const result = history.refresh(); engine.emit('change', { runId: '', at: new Date().toISOString() }); return result; });
  app.get('/api/models', async req => engine.adapter.models(credential(req)));
  app.get('/api/example', async req => {
    const models = await engine.adapter.models(credential(req)); const m = models.find(x => x.isDefault) ?? models[0];
    const spec = exampleSpec(m.id, m.efforts.includes('low') ? 'low' : m.defaultEffort);
    if (engine.adapter.name === 'openai') { spec.maxUtterances = 6; spec.evaluation.interval = 6; spec.concurrentRuns = 1; spec.maxConcurrentCalls = 1; }
    return spec;
  });
  app.get('/api/config', async () => engine.store.setting('lastSpec') ?? null);
  app.put('/api/config', async req => { const spec = experimentSchema.parse(req.body); engine.store.setting('lastSpec', spec); return spec; });
  app.post('/api/validate', async req => ({ valid: true, spec: await engine.validate(req.body, credential(req)) }));
  app.post('/api/experiments', async req => { const { spec, start } = req.body as any; return engine.create(spec, start !== false, credential(req)); });
  app.get<{ Querystring: { provider?: string } }>('/api/runs', async req => {
    const provider = z.enum(['all', 'real', 'codex', 'openai', 'mock']).optional().parse(req.query.provider);
    return history ? history.list(provider) : engine.list(provider);
  });
  app.get<{ Querystring: { runIds?: string } }>('/api/analysis', async req => {
    const ids = req.query.runIds?.split(',');
    const runs = (history ? history.list() : engine.store.list('runs')).filter(r => !ids || ids.includes(r.id));
    return groupedMetrics(runs.flatMap(r => detail(r.id).invocations.map(c => ({ ...c, metadata: { ...c.metadata, adapter: r.adapter } }))));
  });
  app.get<{ Params: { id: string } }>('/api/runs/:id', async req => detail(req.params.id));
  app.get<{ Params: { id: string } }>('/api/runs/:id/config.json', async (req, reply) =>
    reply.type('application/json').header('Content-Disposition', 'attachment; filename="run-config.json"').send(runSnapshot(detail(req.params.id).run)));
  app.get<{ Params: { id: string } }>('/api/runs/:id/deletion', async req => deletion.preview(req.params.id));
  const deletionSelection = z.object({ runIds: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/)).min(1) });
  app.post('/api/runs/deletion-preview', async req => {
    const { runIds } = deletionSelection.strict().parse(req.body);
    return deletion.previewMany(runIds);
  });
  app.delete('/api/runs', async req => {
    const { runIds, token } = deletionSelection.extend({ confirm: z.literal(true), token: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(req.body);
    return deletion.deleteMany(runIds, token);
  });
  app.delete<{ Params: { id: string } }>('/api/runs/:id', async req => {
    const { confirm, token } = z.object({ confirm: z.literal(true), token: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(req.body);
    return confirm && deletion.delete(req.params.id, token);
  });
  app.post<{ Params: { id: string; action: string } }>('/api/runs/:id/:action', async req => {
    const { id, action } = req.params;
    history?.assertWritable(id);
    if (['resume', 'step', 'inject', 'evaluate'].includes(action)) openai?.keys.assertRunAccess(engine.run(id).apiCredential, browserOwner(req));
    if (action === 'pause') await engine.pause(id);
    else if (action === 'resume' || action === 'step') await engine.resume(id, action === 'step');
    else if (action === 'stop') await engine.stop(id);
    else if (action === 'inject') { const input = z.object({ text: z.string(), audience: audienceSchema.optional() }).parse(req.body); await engine.inject(id, input.text, input.audience); }
    else if (action === 'evaluate') await engine.evaluate(id);
    else throw new Error('알 수 없는 동작');
    return detail(id);
  });
  app.patch<{ Params: { id: string } }>('/api/findings/:id', async req => {
    if (history && !engine.store.get('findings', req.params.id)) throw new Error('보관 기록의 평가 검토는 원본 저장소의 서버에서 사용하세요.');
    const patch = z.object({ review: z.enum(['unreviewed', 'confirmed', 'dismissed']).optional(), note: z.string().max(10000).optional() }).strict()
      .refine(value => value.review !== undefined || value.note !== undefined, '검토 상태 또는 메모를 지정하세요.').parse(req.body);
    return engine.review(req.params.id, patch);
  });
  app.get<{ Params: { id: string } }>('/api/runs/:id/export', async req => files(req.params.id));
  app.get<{ Params: { id: string } }>('/api/runs/:id/export.zip', async (req, reply) => reply.type('application/zip').header('Content-Disposition', `attachment; filename="npc-${req.params.id}.zip"`).send(zipFiles(files(req.params.id))));
  const streams = new Set<import('node:http').ServerResponse>();
  app.get('/api/events', (req, reply) => {
    reply.hijack(); reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    streams.add(reply.raw); reply.raw.write('data: {"type":"connected"}\n\n');
    req.raw.on('close', () => streams.delete(reply.raw));
  });
  const listener = (event: unknown) => { for (const stream of streams) stream.write(`data: ${JSON.stringify(event)}\n\n`); };
  engine.on('change', listener);
  const heartbeat = setInterval(() => { for (const stream of streams) stream.write(': heartbeat\n\n'); }, 15_000); heartbeat.unref();
  app.addHook('preClose', async () => { for (const stream of streams) stream.end(); });
  app.addHook('onClose', async () => { engine.off('change', listener); clearInterval(heartbeat); for (const stream of streams) stream.end(); history?.close(); });
  const webDir = resolve('dist/web');
  if (existsSync(webDir)) { await app.register(fastifyStatic, { root: webDir }); app.setNotFoundHandler((req, reply) => req.url.startsWith('/api/') ? reply.code(404).send({ error: '찾을 수 없습니다.' }) : reply.sendFile('index.html')); }
  else app.get('/', async (_req, reply) => reply.type('text/plain; charset=utf-8').send('웹 화면을 먼저 빌드하세요: npm run build')); 
  return app;
}
