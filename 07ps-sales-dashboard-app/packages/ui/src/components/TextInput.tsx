import React from 'react';

export interface TextInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  helperText?: string;
}

/** Shared text/password/email input primitive, styled to match Select.tsx's field chrome
 * (same border/radius/focus-ring tokens) so auth/admin forms look native to this design system. */
export function TextInput({ label, error, helperText, id, style, ...rest }: TextInputProps) {
  const inputId = id ?? (label ? `input-${label.replace(/\s+/g, '-').toLowerCase()}` : undefined);
  return (
    <div style={{ marginBottom: 16 }}>
      {label && (
        <label
          htmlFor={inputId}
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
      )}
      <input
        id={inputId}
        style={{
          width: '100%',
          padding: '8px 10px',
          borderRadius: 8,
          border: `1px solid ${error ? 'var(--ps-color-alert)' : 'var(--ps-color-border)'}`,
          background: 'var(--ps-color-surface)',
          color: 'var(--ps-color-text)',
          fontSize: 14,
          boxSizing: 'border-box',
          ...style,
        }}
        {...rest}
      />
      {error ? (
        <p style={{ fontSize: 12, color: 'var(--ps-color-alert)', marginTop: 4 }}>{error}</p>
      ) : helperText ? (
        <p style={{ fontSize: 12, color: 'var(--ps-color-muted-text)', marginTop: 4 }}>{helperText}</p>
      ) : null}
    </div>
  );
}
