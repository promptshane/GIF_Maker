import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';

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

/**
 * A button that fires once per tap and keeps firing while held, for nudge and
 * stepper controls where a run of a dozen taps would be tedious on a phone.
 *
 * The tap itself is delivered through `click` so keyboards work unchanged;
 * holding starts a repeat timer from `pointerdown`, and the click that follows
 * the release is swallowed so a hold never fires one extra step at the end.
 */
export function RepeatButton({
  onPress,
  className,
  label,
  children,
  delayMs = 350,
  intervalMs = 70,
}: {
  onPress: () => void;
  className?: string;
  label: string;
  children: ReactNode;
  delayMs?: number;
  intervalMs?: number;
}) {
  const pressRef = useRef(onPress);
  pressRef.current = onPress;
  const timers = useRef<{ delay: number | null; interval: number | null }>({
    delay: null,
    interval: null,
  });
  const repeated = useRef(false);

  const stop = () => {
    if (timers.current.delay !== null) window.clearTimeout(timers.current.delay);
    if (timers.current.interval !== null) window.clearInterval(timers.current.interval);
    timers.current = { delay: null, interval: null };
  };
  useEffect(() => stop, []);

  return (
    <button
      type="button"
      className={className}
      aria-label={label}
      onPointerDown={(event) => {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        stop();
        repeated.current = false;
        timers.current.delay = window.setTimeout(() => {
          repeated.current = true;
          pressRef.current();
          timers.current.interval = window.setInterval(() => pressRef.current(), intervalMs);
        }, delayMs);
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onPointerLeave={stop}
      onClick={() => {
        if (repeated.current) {
          repeated.current = false;
          return;
        }
        pressRef.current();
      }}
    >
      {children}
    </button>
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
