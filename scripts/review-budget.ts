import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { TurnResult } from '../src/adapters/types.js';
import { getModelPricing } from '../src/shared/model-catalog.js';

export function reviewBudgetFile(group: string) {
  const legacy = join(group,'budget.sqlite');
  if (existsSync(legacy)) return legacy;
  const dir = join(group,'runtime'); mkdirSync(dir,{recursive:true});
  return join(dir,'budget.sqlite');
}

// Shared across workers and restarts. An unknown outcome keeps its full reservation.
export class ReviewBudget {
  private db: DatabaseSync;
  constructor(file: string, readonly limitUsd: number, private allowedModels: readonly string[] = ['gpt-6-luna','gpt-6.1-terra']) {
    if (!Number.isFinite(limitUsd) || limitUsd <= 0) throw Error('A positive aggregate budget is required.');
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA busy_timeout=15000; CREATE TABLE IF NOT EXISTS budget(limitUsd REAL); CREATE TABLE IF NOT EXISTS requests(call TEXT PRIMARY KEY, model TEXT, charge REAL, response TEXT UNIQUE, context INTEGER);');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const saved = this.db.prepare('SELECT limitUsd FROM budget').get();
      if (saved && saved.limitUsd !== limitUsd) throw Error('The existing aggregate budget differs.');
      if (!saved) this.db.prepare('INSERT INTO budget VALUES (?)').run(limitUsd);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); this.db.close(); throw e; }
  }
  fetch: typeof fetch = async (url, init) => {
    if (init?.redirect !== 'error') throw Error('Review requests require a fixed origin.');
    if (String(url) === 'https://api.openai.com/v1/models' && !init.method) return fetch(url, init);
    if (String(url) !== 'https://api.openai.com/v1/responses' || init.method !== 'POST') throw Error('Unknown review request.');
    const raw = String(init.body), body = JSON.parse(raw);
    const price = getModelPricing(body.model);
    if (!this.allowedModels.includes(body.model) || !price || ![undefined,'none','minimal','low','medium','high'].includes(body.reasoning?.effort)
      || !Number.isSafeInteger(body.max_output_tokens) || body.max_output_tokens <= 0) throw Error('Unpriced or unsupported review configuration.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prev = body.previous_response_id ? this.db.prepare('SELECT context FROM requests WHERE response=?').get(body.previous_response_id) : null;
      if (body.previous_response_id && !Number.isSafeInteger(prev?.context)) throw Error('Unaccounted previous response.');
      const input = Number(prev?.context ?? 0) + Buffer.byteLength(raw) + 4096;
      const rates = price.longContext && input > price.longContext.aboveInputTokens ? price.longContext : price;
      const charge = (input * Math.max(rates.input, rates.cached, rates.write30m ?? 0) + body.max_output_tokens * rates.output) / 1e6;
      if (this.total() + charge > this.limitUsd) throw Error('Aggregate review budget reached before dispatch.');
      this.db.prepare('INSERT INTO requests(call,model,charge) VALUES (?,?,?)').run(body.metadata.npc_lab_call_id, body.model, charge);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return fetch(url, init);
  };
  total() { return Number(this.db.prepare('SELECT COALESCE(SUM(charge),0) AS spent FROM requests').get()!.spent); }
  settle(id: string, result: TurnResult) {
    const u = result.usage;
    if (!u || !result.turnId || u.inputTokens === null || u.outputTokens === null) return;
    const row = this.db.prepare('SELECT model FROM requests WHERE call=?').get(id);
    if (!row) return;
    const price = getModelPricing(String(row.model))!;
    const rates = price.longContext && u.inputTokens > price.longContext.aboveInputTokens ? price.longContext : price;
    const cached = u.cachedInputTokens, written = u.cacheWriteInputTokens;
    const inputCost = cached !== null && written !== null && cached >= 0 && written >= 0 && cached + written <= u.inputTokens
      ? (u.inputTokens - cached - written) * rates.input + cached * rates.cached + written * (rates.write30m ?? rates.input)
      : u.inputTokens * Math.max(rates.input, rates.cached, rates.write30m ?? 0);
    this.db.prepare('UPDATE requests SET charge=?,response=?,context=? WHERE call=?')
      .run((inputCost + u.outputTokens * rates.output) / 1e6, result.turnId, u.inputTokens + u.outputTokens, id);
  }
  close() { this.db.close(); }
  [Symbol.dispose]() { this.close(); }
}
