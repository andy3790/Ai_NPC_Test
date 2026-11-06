import { modelCatalogPath } from '../src/core/load-model-catalog.js';
import { getModelCatalog, PRICING_REVISION } from '../src/shared/model-catalog.js';

const catalog = getModelCatalog();
console.log(JSON.stringify({ status: 'passed', file: modelCatalogPath, models: catalog.models.length,
  selectableApiModels: catalog.models.filter(m => m.enabled && m.api).map(m => m.id),
  pricingDate: catalog.pricingDate, pricingRevision: PRICING_REVISION, modelCalls: 0 }, null, 2));
