import { resolve, join } from 'node:path';
import { openSync, closeSync, readFileSync, unlinkSync, mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Store } from '../core/store.js';
import { Engine } from '../core/engine.js';
import { CodexAdapter } from '../adapters/codex.js';
import { MockAdapter } from '../adapters/mock.js';
import { createApp } from './app.js';
export async function serve(options: { port?: number; data?: string; mock?: boolean } = {}) {
  const data = resolve(options.data ?? process.env.NPC_LAB_DATA ?? 'data'); mkdirSync(data, { recursive: true });
  const lock = join(data, 'server.lock');
  try { const fd = openSync(lock, 'wx'); closeSync(fd); }
  catch {
    const pid = Number(readFileSync(lock, 'utf8'));
    if (pid) { try { process.kill(pid, 0); throw new Error(`이미 실행 중인 서버가 있습니다 (PID ${pid}).`); } catch (e: any) { if (e.code !== 'ESRCH') throw e; } }
    unlinkSync(lock); const fd = openSync(lock, 'wx'); closeSync(fd);
  }
  writeFileSync(lock, String(process.pid));
  const store = new Store(join(data, 'npc-lab.sqlite'));
  const adapter = options.mock || process.env.NPC_LAB_ADAPTER === 'mock' ? new MockAdapter() : new CodexAdapter(join(data, 'runtime'));
  const engine = new Engine(store, adapter, data); const app = await createApp(engine);
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await engine.close(); await app.close(); store.close(); try { unlinkSync(lock); } catch {} };
  process.once('SIGINT', () => void close()); process.once('SIGTERM', () => void close());
  try { await app.listen({ host: '127.0.0.1', port: options.port ?? Number(process.env.PORT ?? 4317) }); }
  catch (e) { await close(); throw e; }
  console.log(`NPC Dialogue Lab · http://127.0.0.1:${options.port ?? process.env.PORT ?? 4317} · ${adapter.name}\n데이터: ${data}`);
  return { app, engine, close };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) serve().catch(e => { console.error(e.message); process.exitCode = 1; });
