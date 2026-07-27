'use client';
import React, { useRef, useState } from 'react';
import { Calendar } from 'lucide-react';

export interface DateInputProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  helperText?: string;
  disabled?: boolean;
}

/**
 * Design-quality pass: replaces the native, unstyled <input type="date"> (Screenshot A). This
 * wraps the native input (rather than building a full custom calendar-grid picker from scratch) --
 * a deliberate scope choice: the Tachometer page only ever needs ONE anchor date (see the
 * correction note in SidebarFilters.tsx - the manual's "Specific Date From/To" is a single date,
 * not a real range), so a full custom calendar widget would be a much larger, separate piece of
 * work relative to what this page actually needs. What's fixed here is exactly what Screenshot A
 * showed as broken: the surrounding chrome (border, background, focus state, icon) now matches the
 * design tokens instead of falling back to raw OS-native styling. The browser's own date-picker
 * popup (opened by the native input) is retained, since replacing that specific piece would be
 * the "swap to a different charting/picker approach entirely" case worth flagging before doing.
 */
export function DateInput({ label, value, onChange, helperText, disabled }: DateInputProps) {
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div style={{ opacity: disabled ? 0.5 : 1, marginBottom: 16 }}>
      <label
        style={{
          display: 'block',
          fontSize: 12,
          textTransform: 'uppercase',
          letterSpacing: 0.4,
          color: 'var(--ps-color-muted-text)',
          marginBottom: 4,
        }}
      >
        {label}
      </label>
      <div
        onClick={() => inputRef.current?.showPicker?.()}
        style={{
          display: 'flex',
          alignItems: 'center',
          height: 38,
          boxSizing: 'border-box',
          gap: 8,
          padding: '0 10px',
          borderRadius: 8,
          border: `1px solid ${focused ? 'var(--ps-color-accent)' : 'var(--ps-color-border)'}`,
          background: 'var(--ps-color-surface)',
          boxShadow: focused ? '0 0 0 3px color-mix(in srgb, var(--ps-color-accent) 20%, transparent)' : 'none',
          cursor: disabled ? 'not-allowed' : 'pointer',
        }}
      >
        <Calendar size={16} style={{ color: 'var(--ps-color-muted-text)', flexShrink: 0, display: 'flex' }} />
        <input
          ref={inputRef}
          type="date"
          className="ps-date-input"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={{
            border: 'none',
            outline: 'none',
            background: 'transparent',
            color: 'var(--ps-color-text)',
            fontSize: 14,
            width: '100%',
            height: '100%',
            fontVariantNumeric: 'tabular-nums',
            colorScheme: 'light dark',
          }}
        />
      </div>
      {helperText && (
        <div style={{ fontSize: 10, color: 'var(--ps-color-muted-text)', marginTop: 4 }}>{helperText}</div>
      )}
    </div>
  );
}
