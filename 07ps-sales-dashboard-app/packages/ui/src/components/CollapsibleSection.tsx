import React, { useState } from 'react';

export interface CollapsibleSectionProps {
  title: string;
  children: React.ReactNode;
  /** Uncontrolled initial state. Defaults to expanded (true). */
  defaultOpen?: boolean;
  /** Small trailing badge, e.g. an active-filter count for this section. */
  badge?: number;
}

/**
 * Complete UI Redesign pass: a collapsible group wrapper for the modernized sidebar's filter
 * sections (Business Unit, Customer Group, Distribution Channel, Branch, Salesperson, Date).
 * Deliberately uncontrolled (own useState) -- AppSidebar just renders one of these per filter
 * group; nothing outside needs to know whether a given section is expanded.
 */
export function CollapsibleSection({ title, children, defaultOpen = true, badge }: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div style={{ borderBottom: '1px solid var(--ps-color-border)', paddingBottom: 'var(--ps-space-2, 8px)' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: 'var(--ps-space-2, 8px) 0',
          color: 'var(--ps-color-text)',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.3 }}>
          {title}
          {typeof badge === 'number' && badge > 0 && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                minWidth: 16,
                height: 16,
                padding: '0 4px',
                borderRadius: 999,
                fontSize: 10,
                fontWeight: 700,
                color: 'var(--ps-color-on-accent)',
                background: 'var(--ps-color-accent)',
              }}
            >
              {badge}
            </span>
          )}
        </span>
        <svg
          width={14}
          height={14}
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden
          style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.15s ease', flexShrink: 0 }}
        >
          <path d="M6 9 L12 15 L18 9" stroke="var(--ps-color-muted-text)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && <div style={{ paddingBottom: 'var(--ps-space-2, 8px)' }}>{children}</div>}
    </div>
  );
}
