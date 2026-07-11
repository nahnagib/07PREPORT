'use client';
import React from 'react';
import Link from 'next/link';
import { Gauge as GaugeIcon, AlertTriangle, TrendingUp, FileText, Users, Settings } from 'lucide-react';

/**
 * Left icon-only navigation rail - MODERNIZATION PASS, EXPLICIT DEVIATION FROM STANDARDS SECTION
 * 3.3 ("Primary nav: persistent bottom tab bar"). The bottom tab bar (NavTabBar.tsx) was the
 * deliberate choice in the earlier design-quality pass; this session's mockup showed a dark
 * left icon rail instead, and the user was asked directly which to build given the standards
 * conflict - they chose the icon rail. NavTabBar.tsx is left in the codebase (unused by either
 * page now) rather than deleted, in case a future session needs to revert this call.
 *
 * Only "Tachometer" is a real, built page (links to '/') - the other four remain disabled
 * placeholders with the same "Phase P3 builds these pages" tooltip NavTabBar used, since building
 * them is still out of scope.
 */
const NAV_ITEMS = [
  { label: 'Tachometer', icon: GaugeIcon, href: '/' },
  { label: 'Critical Number', icon: AlertTriangle, href: null },
  { label: 'Revenue Trend', icon: TrendingUp, href: null },
  { label: 'Invoices Engine', icon: FileText, href: null },
  { label: 'Customer Growth', icon: Users, href: null },
] as const;

export function IconNavRail({ active = 'Tachometer' }: { active?: string }) {
  return (
    <nav
      aria-label="Page navigation"
      style={{
        width: 64,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
        padding: '16px 0',
        background: 'var(--ps-color-nav-rail-bg)',
        height: '100vh',
        position: 'sticky',
        top: 0,
      }}
    >
      {NAV_ITEMS.map(({ label, icon: Icon, href }) => {
        const isActive = label === active;
        const buttonStyle: React.CSSProperties = {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 40,
          height: 40,
          borderRadius: 10,
          border: 'none',
          background: isActive ? 'var(--ps-color-nav-rail-active-bg)' : 'transparent',
          color: isActive ? 'var(--ps-color-nav-rail-icon-active)' : 'var(--ps-color-nav-rail-icon)',
          cursor: href ? 'pointer' : 'not-allowed',
          opacity: href ? 1 : 0.55,
        };

        if (href) {
          return (
            <Link key={label} href={href} aria-label={label} title={label} style={buttonStyle}>
              <Icon size={20} />
            </Link>
          );
        }
        return (
          <button
            key={label}
            disabled
            aria-label={label}
            title={`${label} - Phase P3 builds this page, foundation shell only for now`}
            style={buttonStyle}
          >
            <Icon size={20} />
          </button>
        );
      })}

      <div style={{ flex: 1 }} />

      <button
        disabled
        aria-label="Settings"
        title="Settings - not built yet"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 40,
          height: 40,
          borderRadius: 10,
          border: 'none',
          background: 'transparent',
          color: 'var(--ps-color-nav-rail-icon)',
          opacity: 0.55,
          cursor: 'not-allowed',
        }}
      >
        <Settings size={20} />
      </button>
    </nav>
  );
}
