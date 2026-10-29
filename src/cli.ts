#!/usr/bin/env node
import { Command } from 'commander';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { serve } from './server/main.js';
const cli = new Command().name('npc-lab').description('Codex CLI 기반 NPC 대화 실험').option('--url <url>', '서버 주소', 'http://127.0.0.1:4317');
async function api(path: string, body?: unknown, method?: string) {
  const response = await fetch(`${cli.opts().url}/api${path}`, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json() as any; if (!response.ok) throw new Error(result.error ?? response.statusText); return result;
}
const print = (v: unknown) => console.log(JSON.stringify(v, null, 2));
cli.command('serve').option('--port <port>', '포트', '4317').option('--data <directory>', '저장 폴더', 'data').option('--mock', '모의 모델 사용').action(async o => { await serve({ port: Number(o.port), data: o.data, mock: o.mock }); });
cli.command('models').action(async () => print(await api('/models')));
cli.command('example').option('--out <file>', 'JSON 파일 경로').action(async o => { const spec = await api('/example'); if (o.out) await writeFile(resolve(o.out), JSON.stringify(spec, null, 2)); else print(spec); });
cli.command('validate').requiredOption('--config <file>', '설정 JSON').action(async o => print(await api('/validate', JSON.parse(await readFile(resolve(o.config), 'utf8')))));
cli.command('run').requiredOption('--config <file>', '설정 JSON').option('--paused', '일시정지 상태로 생성').action(async o => print(await api('/experiments', { spec: JSON.parse(await readFile(resolve(o.config), 'utf8')), start: !o.paused })));
cli.command('status').argument('[id]', '묶음 ID').action(async id => print(await api(id ? `/runs/${id}` : '/runs')));
cli.command('analysis').option('--runs <ids>', '쉼표로 구분한 묶음 ID').action(async o => print(await api(`/analysis${o.runs ? `?runIds=${encodeURIComponent(o.runs)}` : ''}`)));
for (const action of ['pause', 'resume', 'step', 'stop', 'evaluate']) cli.command(action).argument('<id>', '묶음 ID').action(async id => print(await api(`/runs/${id}/${action}`, {})));
cli.command('inject').argument('<id>', '묶음 ID').requiredOption('--text <text>', '상황 내용').action(async (id, o) => print(await api(`/runs/${id}/inject`, { text: o.text })));
cli.command('export').argument('<id>', '묶음 ID').requiredOption('--out <directory>', '출력 폴더').action(async (id, o) => { const files = await api(`/runs/${id}/export`); const directory = resolve(o.out); await mkdir(directory, { recursive: true }); for (const [name, content] of Object.entries(files)) await writeFile(join(directory, name), String(content)); console.log(directory); });
cli.parseAsync().catch(e => { console.error(e.message, '\n서버가 필요하면 npm run cli -- serve 를 먼저 실행하세요.'); process.exitCode = 1; });
