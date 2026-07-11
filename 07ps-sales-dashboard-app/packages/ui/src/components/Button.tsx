import React from 'react';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  fullWidth?: boolean;
}

const VARIANT_STYLE: Record<NonNullable<ButtonProps['variant']>, React.CSSProperties> = {
  primary: {
    background: 'var(--ps-color-accent)',
    color: 'var(--ps-color-on-accent)',
    border: '1px solid transparent',
  },
  secondary: {
    background: 'var(--ps-color-surface)',
    color: 'var(--ps-color-text)',
    border: '1px solid var(--ps-color-border)',
  },
  danger: {
    background: 'var(--ps-color-alert)',
    color: '#ffffff',
    border: '1px solid transparent',
  },
  ghost: {
    background: 'transparent',
    color: 'var(--ps-color-text)',
    border: '1px solid transparent',
  },
};

/** Shared button primitive -- every admin/auth page uses this instead of re-styling raw
 * <button> elements, per @07ps/ui being the only component library every page uses. */
export function Button({
  variant = 'primary',
  fullWidth,
  disabled,
  style,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      disabled={disabled}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        padding: '9px 16px',
        borderRadius: 8,
        fontSize: 14,
        fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        width: fullWidth ? '100%' : undefined,
        transition: 'opacity 0.15s ease-out',
        ...VARIANT_STYLE[variant],
        ...style,
      }}
      {...rest}
    >
      {children}
    </button>
  );
}
