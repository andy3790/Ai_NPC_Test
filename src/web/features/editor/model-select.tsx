import { preferredEffort } from '../../../shared/role-models.js';
import type { ModelInfo } from '../../../shared/types.js';
import { getModelPricing, PRICING_DATE, PRICING_SOURCE } from '../../../shared/model-catalog.js';

const money = (value: number) => '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
export function modelDefaultEffort(models: ModelInfo[], id: string) {
  const model = models.find(m => m.id === id);
  return preferredEffort(model);
}
export function modelPriceLabel(model: string) {
  if (model === 'mock-model') return '모의 모델 · 과금 없음';
  const rate = getModelPricing(model);
  return rate ? `입력 ${money(rate.input)} · 출력 ${money(rate.output)}` : '단가 미등록';
}
export function ModelPrice({ model, compact = false }: { model: string; compact?: boolean }) {
  const rate = getModelPricing(model);
  return <small className="model-price" data-model={model}>
    <span className="model-price-main">{modelPriceLabel(model)}</span>
    {rate && <span>USD / 100만 토큰 · Standard{!compact && ` · 캐시 입력 ${money(rate.cached)}`}</span>}
    {!compact && rate?.longContext && <span>입력 {rate.longContext.aboveInputTokens.toLocaleString('ko-KR')}토큰 초과: 입력 {money(rate.longContext.input)} · 출력 {money(rate.longContext.output)}</span>}
    {!rate && model !== 'mock-model' && <span>공식 단가를 등록하면 표시됩니다.</span>}
  </small>;
}
export function ModelPricingNote() {
  return <p className="model-pricing-note">API 텍스트 단가 · USD / 100만 토큰 · Standard 기본 요금 · {PRICING_DATE} 확인
    {' · '}<a href={PRICING_SOURCE} target="_blank" rel="noreferrer">공식 요금표</a>
    <br/>Codex CLI는 API 단가 기준의 비교용 금액입니다. 긴 입력에는 표시된 장문 요금이 적용됩니다.</p>;
}
export function ModelSelect({ label, value, models, onChange, inheritLabel, inheritedModels = [] }: {
  label: string; value: string; models: ModelInfo[]; onChange: (value: string) => void;
  inheritLabel?: string; inheritedModels?: string[];
}) {
  const available = models.some(m => m.id === value);
  return <span className="model-field">
    <select aria-label={label} value={value} onChange={e => onChange(e.target.value)}>
      {inheritLabel && <option value="">{inheritLabel}</option>}
      {!inheritLabel && !value && <option value="" disabled>모델을 선택하세요</option>}
      {value && !available && <option value={value} disabled>{value} · 선택 불가</option>}
      {models.map(m => <option key={m.id} value={m.id}>{m.name !== m.id ? `${m.name} (${m.id})` : m.id} · {modelPriceLabel(m.id)}</option>)}
    </select>
    {value ? <><ModelPrice model={value}/>{!available && <small className="model-unavailable">현재 목록에 없는 모델입니다. 다른 모델을 선택하세요.</small>}</> :
      [...new Set(inheritedModels)].map(model => <span className="model-inherited" key={model}><small>조건 적용: {model}</small><ModelPrice model={model} compact/></span>)}
  </span>;
}
