'use client';
import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Home, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { DEPARTMENTS } from '../lib/departments';
import { ADMIN_NAV_ITEM } from '../lib/navItems';
import { useAuth } from '../lib/AuthProvider';

/**
 * Permanent left sidebar shown on every department route (mounted once by
 * `app/(departments)/layout.tsx`, a route group so adding a new department later never means
 * touching this component). Modeled on the existing `IconNavRail.tsx` -- reuses its
 * `--ps-color-nav-rail-*` tokens (already defined in tokens.css) rather than inventing new ones --
 * but as a labeled, collapsible sidebar instead of icon-only, per the redesign spec.
 *
 * Also carries an Admin entry (permission-gated, same `canView` checks `BottomNavBar` uses) at the
 * bottom -- added per explicit user request after Admin briefly had no nav entry point once
 * BottomNavBar was dropped from the Tachometer page. Kept here too (not just on BottomNavBar) so
 * Admin stays reachable from every department page, not only Tachometer.
 */
export function DepartmentSidebar() {
  const pathname = usePathname();
  const { canView } = useAuth();
  const [expanded, setExpanded] = useState(true);
  const showAdmin =
    canView('admin_users') || canView('admin_roles') || canView('admin_login_history') || canView('admin_etl');

  // Default to collapsed on narrower viewports (tablet and below) so it doesn't eat into content
  // width on first load; user's manual toggle afterwards always wins.
  useEffect(() => {
    if (window.innerWidth < 1024) setExpanded(false);
  }, []);

  const isHomeActive = pathname === '/';

  return (
    <nav
      aria-label="Department navigation"
      style={{
        width: expanded ? 240 : 64,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--ps-color-nav-rail-bg)',
        height: '100vh',
        position: 'sticky',
        top: 0,
        transition: 'width 0.2s ease',
        overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, padding: '16px 12px', gap: 4, overflowY: 'auto' }}>
        <SidebarItem href="/" label="Home" icon={Home} active={isHomeActive} expanded={expanded} />

        <div
          aria-hidden
          style={{ height: 1, background: 'rgba(255,255,255,0.12)', margin: '8px 4px 12px' }}
        />

        {DEPARTMENTS.map((dept) => {
          const active = pathname === dept.href || pathname.startsWith(`${dept.href}/`);
          return (
            <SidebarItem
              key={dept.key}
              href={dept.href}
              label={dept.pTerm}
              icon={dept.icon}
              active={active}
              expanded={expanded}
              accent={dept.accent}
            />
          );
        })}
      </div>

      {showAdmin && (
        <div style={{ padding: '0 12px 12px', borderTop: '1px solid rgba(255,255,255,0.12)', marginTop: 4 }}>
          <div style={{ paddingTop: 12 }}>
            <SidebarItem
              href={ADMIN_NAV_ITEM.href}
              label={ADMIN_NAV_ITEM.label}
              icon={ADMIN_NAV_ITEM.icon}
              active={pathname.startsWith('/admin')}
              expanded={expanded}
            />
          </div>
        </div>
      )}

      <button
        onClick={() => setExpanded((e) => !e)}
        aria-label={expanded ? 'Collapse sidebar' : 'Expand sidebar'}
        title={expanded ? 'Collapse sidebar' : 'Expand sidebar'}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: expanded ? 'flex-end' : 'center',
          gap: 8,
          border: 'none',
          borderTop: '1px solid rgba(255,255,255,0.12)',
          background: 'transparent',
          color: 'var(--ps-color-nav-rail-icon)',
          padding: '14px 16px',
          cursor: 'pointer',
        }}
        className="ps-sidebar-toggle"
      >
        {expanded ? <ChevronsLeft size={18} /> : <ChevronsRight size={18} />}
      </button>
    </nav>
  );
}

function SidebarItem({
  href,
  label,
  icon: Icon,
  active,
  expanded,
  accent,
}: {
  href: string;
  label: string;
  icon: React.ComponentType<{ size?: number | string }>;
  active: boolean;
  expanded: boolean;
  accent?: string;
}) {
  return (
    <Link
      href={href}
      aria-label={label}
      title={expanded ? undefined : label}
      className="ps-sidebar-item"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        height: 44,
        padding: '0 10px',
        borderRadius: 10,
        textDecoration: 'none',
        background: active ? (accent ? `color-mix(in srgb, ${accent} 28%, transparent)` : 'var(--ps-color-nav-rail-active-bg)') : 'transparent',
        color: active ? 'var(--ps-color-nav-rail-icon-active)' : 'var(--ps-color-nav-rail-icon)',
        transition: 'background 0.15s ease, color 0.15s ease',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
      }}
    >
      <Icon size={19} />
      {expanded && (
        <span style={{ fontSize: 13.5, fontWeight: active ? 700 : 600, opacity: expanded ? 1 : 0 }}>{label}</span>
      )}
    </Link>
  );
}
