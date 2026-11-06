import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { installModelCatalog } from '../shared/model-catalog.js';

// Resolve to the editable source file from either src/core or dist/core.
// Compiled servers intentionally do not rely on dist's copied JSON.
export const modelCatalogPath = fileURLToPath(new URL('../../src/config/models.json', import.meta.url));
export function loadModelCatalog(path = modelCatalogPath) {
  try { installModelCatalog(JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))); }
  catch (error) { throw new Error(`모델 설정을 불러올 수 없습니다 (${path}): ${error instanceof Error ? error.message : String(error)}`); }
}
loadModelCatalog();
