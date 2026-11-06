import { z } from 'zod';
import bundledCatalog from '../config/models.json' with { type: 'json' };

const effort = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export const apiModelProfileSchema = z.object({
  efforts: z.array(effort).min(1), defaultEffort: effort, reasoning: z.boolean(),
}).strict().superRefine((profile, ctx) => {
  if (new Set(profile.efforts).size !== profile.efforts.length || !profile.efforts.includes(profile.defaultEffort))
    ctx.addIssue({ code: 'custom', message: '추론 강도는 중복 없이 입력하고 defaultEffort를 efforts에 포함하세요.' });
  if (!profile.reasoning && profile.efforts.some(value => value !== 'none'))
    ctx.addIssue({ code: 'custom', message: '비추론 모델은 none만 사용할 수 있습니다.' });
});
const money = z.number().finite().nonnegative();
const rateSchema = z.object({ input: money, cached: money, output: money, write30m: money.optional() }).strict();
const pricingSchema = rateSchema.extend({
  longContext: rateSchema.extend({ aboveInputTokens: z.number().int().positive() }).optional(),
});
const modelSchema = z.object({
  id: z.string().min(1).max(200).regex(/^\S+$/, '모델 ID에는 공백을 넣을 수 없습니다.'),
  name: z.string().min(1).max(200).optional(), enabled: z.boolean(),
  api: apiModelProfileSchema.nullable(), pricing: pricingSchema.nullable(),
  source: z.url().startsWith('https://').optional(),
}).strict();
export const modelCatalogSchema = z.object({
  schemaVersion: z.literal(1), pricingDate: z.iso.date(), pricingSource: z.url().startsWith('https://'),
  models: z.array(modelSchema).min(1),
}).strict().superRefine((catalog, ctx) => {
  const seen = new Set<string>();
  for (const [i, model] of catalog.models.entries()) {
    if (seen.has(model.id)) ctx.addIssue({ code: 'custom', path: ['models', i, 'id'], message: '모델 ID가 중복되었습니다.' });
    seen.add(model.id);
  }
});
export type ModelCatalog = z.infer<typeof modelCatalogSchema>;
export type CatalogModel = ModelCatalog['models'][number];

// A deterministic cache revision, not a security hash. Date-only edits are not
// required to invalidate archived cost summaries when a rate changes.
function revision(value: ModelCatalog) {
  let hash = 0xcbf29ce484222325n;
  for (const c of JSON.stringify(value)) hash = BigInt.asUintN(64, (hash ^ BigInt(c.codePointAt(0)!)) * 0x100000001b3n);
  return hash.toString(16).padStart(16, '0');
}
let catalog = modelCatalogSchema.parse(bundledCatalog);
let byId = new Map(catalog.models.map(model => [model.id, model]));
export let PRICING_DATE = catalog.pricingDate;
export let PRICING_SOURCE = catalog.pricingSource;
export let PRICING_REVISION = revision(catalog);
export function installModelCatalog(value: unknown) {
  const parsed = modelCatalogSchema.parse(value);
  // Validate before replacing anything; an invalid update leaves the last value intact.
  catalog = parsed; byId = new Map(parsed.models.map(model => [model.id, model]));
  PRICING_DATE = parsed.pricingDate; PRICING_SOURCE = parsed.pricingSource; PRICING_REVISION = revision(parsed);
}
export function getModelCatalog(): ModelCatalog { return structuredClone(catalog); }
export function getCatalogModel(id: string): CatalogModel | undefined {
  const model = byId.get(id); return model ? structuredClone(model) : undefined;
}
export function isModelEnabled(id: string) { return byId.get(id)?.enabled !== false; }
export function getModelPricing(id: string) { return getCatalogModel(id)?.pricing ?? null; }
