'use client';
import React from 'react';

/**
 * Standards Section 3.3 - Navigation Style.
 * Primary nav: persistent bottom tab bar listing sibling pages within the dashboard.
 * Active tab is always visually distinct (filled/dark background).
 * Phase P2 exit criterion: nav is demonstrable with page placeholders - no live pages built yet.
 */
const SALES_PAGES = ['Tachometer', 'Critical Number', 'Revenue Trend', 'Invoices Engine', 'Customer Growth'];

export function NavTabBar({ active = SALES_PAGES[0] }: { active?: string }) {
  return (
    <nav
      style={{
        display: 'flex',
        borderTop: '1px solid var(--ps-color-border)',
        background: 'var(--ps-color-surface)',
        position: 'sticky',
        bottom: 0,
        overflowX: 'auto',
      }}
      aria-label="Page navigation"
    >
      {SALES_PAGES.map((page) => {
        const isActive = page === active;
        return (
          <button
            key={page}
            disabled
            title="Phase P3 builds these pages - foundation shell only in this phase"
            style={{
              flex: '1 0 auto',
              padding: '10px 16px',
              fontSize: 13,
              fontWeight: isActive ? 700 : 500,
              color: isActive ? 'var(--ps-color-on-accent)' : 'var(--ps-color-text)',
              background: isActive ? 'var(--ps-color-accent)' : 'transparent',
              border: 'none',
              cursor: 'not-allowed',
              opacity: isActive ? 1 : 0.6,
            }}
          >
            {page}
          </button>
        );
      })}
    </nav>
  );
}
