'use client';
import React from 'react';
import Link from 'next/link';

/**
 * Tachometer rebuild (dark-theme pass): horizontal top tab strip, positioned directly under the
 * header, matching the reference screenshot's row of page tabs (Tachometer / Critical Number /
 * Revenue Trend / ... / TT Forced Closure). Same "only Tachometer is real" convention as
 * IconNavRail.tsx (left in place, unused, on this page) -- every other tab is a disabled
 * placeholder with a tooltip explaining it isn't built yet, never a silently-broken link.
 */
const TABS = [
  { label: 'Tachometer', href: '/' },
  { label: 'Critical Number', href: null },
  { label: 'Revenue Trend', href: null },
  { label: 'Invoices Engine', href: null },
  { label: 'Customers Growth', href: null },
  { label: 'Pipeline Health', href: null },
  { label: 'Pipeline Hand', href: null },
  { label: 'Activity Momentum', href: null },
  { label: 'BOSI', href: null },
  { label: 'Stock Velocity', href: null },
  { label: 'PIM', href: null },
  { label: 'TT Forced Closure', href: null },
] as const;

export function TopTabBar({ active = 'Tachometer' }: { active?: string }) {
  return (
    <nav
      aria-label="Dashboard pages"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--ps-space-4, 24px)',
        padding: '0 var(--ps-space-4, 24px)',
        height: 40,
        background: 'var(--ps-color-surface)',
        borderBottom: '1px solid var(--ps-color-border)',
        overflowX: 'auto',
      }}
    >
      {TABS.map(({ label, href }) => {
        const isActive = label === active;
        const style: React.CSSProperties = {
          display: 'inline-flex',
          alignItems: 'center',
          height: '100%',
          fontSize: 12.5,
          fontWeight: isActive ? 700 : 600,
          color: isActive ? 'var(--ps-color-text)' : 'var(--ps-color-muted-text)',
          borderBottom: isActive ? '2px solid var(--ps-color-gold)' : '2px solid transparent',
          whiteSpace: 'nowrap',
          cursor: href ? 'pointer' : 'not-allowed',
          opacity: href ? 1 : 0.55,
          textDecoration: 'none',
        };
        if (href) {
          return (
            <Link key={label} href={href} style={style}>
              {label}
            </Link>
          );
        }
        return (
          <span key={label} title={`${label} - not built yet`} style={style}>
            {label}
          </span>
        );
      })}
    </nav>
  );
}
