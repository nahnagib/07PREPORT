'use client';
import React, { useRef } from 'react';
import { X } from 'lucide-react';
import { formatDate } from '../locale';

export interface DateFieldProps {
  /** ISO calendar date (YYYY-MM-DD) or ''. */
  value: string;
  onChange: (value: string) => void;
  min?: string;
  max?: string;
  disabled?: boolean;
  /** Browser form validation, as on a native input. */
  required?: boolean;
  /** Shown when there's no date. */
  placeholder?: string;
  'aria-label'?: string;
  'aria-invalid'?: boolean;
  /** Shows a small clear (×) button while a date is set. */
  clearable?: boolean;
  onFocus?: () => void;
  onBlur?: () => void;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * A date field that always shows the app's en-GB format ("01 Jan 2026"). A native
 * <input type="date"> displays in the browser's own locale (mm/dd/yyyy on an en-US Chrome) and
 * that can't be changed from code, so the native input sits invisibly over the formatted text:
 * clicking anywhere opens the browser's own calendar, and keyboard entry still works on the
 * focused input.
 */
export function DateField({
  value,
  onChange,
  min,
  max,
  disabled,
  required,
  placeholder = 'Select a date',
  clearable = false,
  onFocus,
  onBlur,
  className,
  style,
  ...aria
}: DateFieldProps) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <span
      className={className}
      onClick={() => {
        if (!disabled) {
          try {
            ref.current?.showPicker?.();
          } catch {
            // showPicker can refuse (e.g. no user activation); the focused input still takes keys.
          }
        }
      }}
      style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 6, cursor: disabled ? 'not-allowed' : 'pointer', ...style }}
    >
      <span
        aria-hidden
        style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', color: value ? 'inherit' : 'var(--ps-color-muted-text)', pointerEvents: 'none' }}
      >
        {value ? formatDate(value) : placeholder}
      </span>
      <input
        ref={ref}
        type="date"
        value={value}
        min={min}
        max={max}
        disabled={disabled}
        required={required}
        aria-label={aria['aria-label']}
        aria-invalid={aria['aria-invalid']}
        onChange={(e) => onChange(e.target.value)}
        onFocus={onFocus}
        onBlur={onBlur}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0, margin: 0, padding: 0, border: 'none', cursor: 'inherit' }}
      />
      {clearable && value && !disabled && (
        <button
          type="button"
          aria-label="Clear date"
          title="Clear date"
          onClick={(e) => {
            e.stopPropagation();
            onChange('');
          }}
          style={{ position: 'relative', zIndex: 1, display: 'inline-flex', border: 'none', background: 'none', padding: 2, color: 'var(--ps-color-muted-text)', cursor: 'pointer' }}
        >
          <X size={13} />
        </button>
      )}
    </span>
  );
}
