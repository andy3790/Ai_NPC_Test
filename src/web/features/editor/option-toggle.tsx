import { useId } from 'react';

export function OptionToggle({ label, title, description, checked, disabled = false, controls, onChange }: {
  label: string; title: string; description?: string; checked: boolean; disabled?: boolean;
  controls?: string; onChange: (checked: boolean) => void;
}) {
  const descriptionId = useId();
  return <label className={`option-toggle${checked ? ' is-enabled' : ''}${disabled ? ' is-disabled' : ''}`}>
    <input type="checkbox" aria-label={label} checked={checked} disabled={disabled}
      aria-controls={controls} aria-describedby={description ? descriptionId : undefined}
      onChange={event => onChange(event.target.checked)}/>
    <span className="option-toggle-copy"><strong>{title}</strong>
      {description && <small id={descriptionId}>{description}</small>}
    </span>
    <span className="option-toggle-state" aria-hidden="true">{disabled ? '사용 불가' : checked ? '사용 중' : '꺼짐'}</span>
  </label>;
}
