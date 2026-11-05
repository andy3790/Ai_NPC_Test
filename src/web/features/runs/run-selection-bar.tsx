import { useEffect, useRef } from 'react';

export function RunSelectionBar({ count, selectedCount, disabled, onSelectAll, onClear, onDelete }: {
  count: number; selectedCount: number; disabled: boolean;
  onSelectAll: (checked: boolean) => void; onClear: () => void; onDelete: () => void;
}) {
  const checkbox = useRef<HTMLInputElement>(null);
  useEffect(() => { if (checkbox.current) checkbox.current.indeterminate = selectedCount > 0 && selectedCount < count; }, [count, selectedCount]);
  return <div className="run-selection-bar" aria-label="대화 묶음 선택">
    <label><input ref={checkbox} type="checkbox" aria-label="필터 결과 전체 선택" checked={count > 0 && selectedCount === count} disabled={disabled || count === 0} onChange={event => onSelectAll(event.target.checked)}/>필터 결과 전체 선택 <span>({count}개)</span></label>
    <strong role="status">선택 {selectedCount}개</strong>
    <div><button disabled={disabled || !selectedCount} onClick={onClear}>선택 해제</button><button className="danger-button" disabled={disabled || !selectedCount} onClick={onDelete}>선택 삭제 ({selectedCount}개)</button></div>
    <small>필터에서 제외된 묶음은 선택이 해제됩니다. 새로 들어오는 기록은 자동 선택하지 않습니다.</small>
  </div>;
}
