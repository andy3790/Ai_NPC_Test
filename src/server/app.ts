import Fastify from 'fastify';
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

export async function createApp(engine: Engine) {
  const app = Fastify({ logger: false, bodyLimit: 4 * 1024 * 1024 });
  // Loopback binding plus Origin/Host checks prevent browser-driven writes from other sites.
  app.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host ?? '';
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)) return reply.code(403).send({ error: '로컬 연결만 허용합니다.' });
    const origin = request.headers.origin;
    if (origin && origin !== `http://${host}`) return reply.code(403).send({ error: '다른 출처의 요청은 허용하지 않습니다.' });
  });
  app.setErrorHandler((error, _request, reply) => reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }));
  app.get('/api/health', async () => ({ ok: true, adapter: engine.adapter.name, version: APP_VERSION }));
  app.get('/api/models', async () => engine.adapter.models());
  app.get('/api/example', async () => {
    const models = await engine.adapter.models(); const m = models.find(x => x.isDefault) ?? models[0];
    return exampleSpec(m.id, m.efforts.includes('low') ? 'low' : m.defaultEffort);
  });
  app.get('/api/config', async () => engine.store.setting('lastSpec') ?? null);
  app.put('/api/config', async req => { const spec = experimentSchema.parse(req.body); engine.store.setting('lastSpec', spec); return spec; });
  app.post('/api/validate', async req => ({ valid: true, spec: await engine.validate(req.body) }));
  app.post('/api/experiments', async req => { const { spec, start } = req.body as any; return engine.create(spec, start !== false); });
  app.get('/api/runs', async () => engine.store.list('runs').reverse().map(r => ({ ...r, maxUtterances: r.spec.maxUtterances, sessions: undefined, helperSessions: undefined, spec: undefined, summary: engine.detail(r.id).summary })));
  app.get<{ Querystring: { runIds?: string } }>('/api/analysis', async req => {
    const ids = req.query.runIds?.split(',');
    const runs = engine.store.list('runs').filter(r => !ids || ids.includes(r.id));
    return groupedMetrics(runs.flatMap(r => engine.store.list('invocations', r.id).map(c => ({ ...c, metadata: { ...c.metadata, adapter: r.adapter } }))));
  });
  app.get<{ Params: { id: string } }>('/api/runs/:id', async req => engine.detail(req.params.id));
  app.post<{ Params: { id: string; action: string } }>('/api/runs/:id/:action', async req => {
    const { id, action } = req.params;
    if (action === 'pause') await engine.pause(id);
    else if (action === 'resume' || action === 'step') await engine.resume(id, action === 'step');
    else if (action === 'stop') await engine.stop(id);
    else if (action === 'inject') await engine.inject(id, z.object({ text: z.string() }).parse(req.body).text);
    else if (action === 'evaluate') await engine.evaluate(id);
    else throw new Error('알 수 없는 동작');
    return engine.detail(id);
  });
  app.patch<{ Params: { id: string } }>('/api/findings/:id', async req => { const body = z.object({ review: z.enum(['unreviewed', 'confirmed', 'dismissed']), note: z.string().max(10000) }).parse(req.body); return engine.review(req.params.id, body.review, body.note); });
  app.get<{ Params: { id: string } }>('/api/runs/:id/export', async req => exportFiles(engine.detail(req.params.id), engine.store.events(req.params.id)));
  app.get<{ Params: { id: string } }>('/api/runs/:id/export.zip', async (req, reply) => reply.type('application/zip').header('Content-Disposition', `attachment; filename="npc-${req.params.id}.zip"`).send(zipFiles(exportFiles(engine.detail(req.params.id), engine.store.events(req.params.id)))));
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
  app.addHook('onClose', async () => { engine.off('change', listener); clearInterval(heartbeat); for (const stream of streams) stream.end(); });
  const webDir = resolve('dist/web');
  if (existsSync(webDir)) { await app.register(fastifyStatic, { root: webDir }); app.setNotFoundHandler((req, reply) => req.url.startsWith('/api/') ? reply.code(404).send({ error: '찾을 수 없습니다.' }) : reply.sendFile('index.html')); }
  else app.get('/', async (_req, reply) => reply.type('text/plain; charset=utf-8').send('웹 화면을 먼저 빌드하세요: npm run build')); 
  return app;
}
