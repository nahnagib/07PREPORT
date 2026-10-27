import React from 'react';
import { Clock } from 'lucide-react';

/** The amber "Coming soon" pill for pages announced in the navigation before they are built (navItems comingSoon). */
export function ComingSoonTag({ style }: { style?: React.CSSProperties }) {
  return (
    <span
      data-testid="coming-soon-tag"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 999,
        fontSize: 11, fontWeight: 700, letterSpacing: 0.3, textTransform: 'uppercase', whiteSpace: 'nowrap',
        background: 'var(--ps-color-watch-bg)', color: 'var(--ps-color-watch)', ...style,
      }}
    >
      <Clock size={12} aria-hidden />
      Coming soon
    </span>
  );
}
