import type { ReactNode } from 'react';
import { useEffect } from 'react';

export function Field({
  label,
  value,
  children,
}: {
  label: string;
  value?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <div className="field-label">
        <span>{label}</span>
        {value !== undefined && <span className="value">{value}</span>}
      </div>
      {children}
    </div>
  );
}

export interface Option<T> {
  value: T;
  label: string;
}

export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: Option<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel?: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <div className="toggle-row">
      <span>{label}</span>
      <button
        type="button"
        className="switch"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
      />
    </div>
  );
}

export function Sheet({
  open,
  onClose,
  children,
  labelledBy,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  labelledBy?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="sheet-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
        <div className="sheet-grab" />
        {children}
      </div>
    </div>
  );
}

export function ErrorBanner({
  message,
  hint,
  onDismiss,
}: {
  message: string;
  hint?: string;
  onDismiss: () => void;
}) {
  return (
    <div className="banner" role="alert">
      <div className="grow">
        <div>{message}</div>
        {hint && <div className="banner-hint">{hint}</div>}
      </div>
      <button type="button" onClick={onDismiss} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}

export function BusyVeil({ label, progress }: { label: string; progress?: number }) {
  return (
    <div className="busy-veil" role="status" aria-live="polite">
      <div>
        <div className="spinner" />
        <div>{label}</div>
        {progress !== undefined && (
          <div className="progress-track" style={{ width: 200 }}>
            <div className="progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        )}
      </div>
    </div>
  );
}
