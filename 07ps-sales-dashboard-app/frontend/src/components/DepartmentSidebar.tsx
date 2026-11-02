'use client';
import React, { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Home, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { DEPARTMENTS } from '../lib/departments';
import { ADMIN_NAV_ITEM, adminNavHref, departmentIsBuilt, departmentReports } from '../lib/navItems';
import { useAuth } from '../lib/AuthProvider';
import {
  SIDEBAR_EXPANDED_WIDTH,
  SIDEBAR_ID,
  SIDEBAR_RAIL_WIDTH,
  SIDEBAR_TRANSITION_MS,
  useSidebar,
  type SidebarState,
} from './SidebarProvider';

/**
 * Permanent left sidebar shown on every department route (mounted once by `app/(departments)/layout.tsx`, a route
 * group so adding a new department later never means touching this component). Reuses IconNavRail's
 * `--ps-color-nav-rail-*` tokens.
 *
 * Collapse / expand (2026-11-02): the state lives in SidebarProvider, shared by every screen size. Desktop: 240px with
 * labels, or a 64px icon rail (hover / focus an icon for its name; the active page stays highlighted); the page
 * content takes the freed width and charts get a resize once the 200ms transition ends. Small screens: the rail stays
 * in the page and "open" lays the labelled sidebar over it, with a backdrop that closes it on a tap. Logical
 * properties throughout, so in RTL it sits on the right and collapses toward the right edge, arrows mirrored.
 *
 * Also carries an Admin entry (permission-gated, same `canView` checks `BottomNavBar` uses) at the bottom.
 */
export function DepartmentSidebar() {
  const sidebar = useSidebar();
  const fallback = useFallbackState();
  const state = sidebar ?? fallback;
  const pathname = usePathname();
  const { canView, isAdmin } = useAuth();
  const adminHref = adminNavHref(canView, isAdmin);
  const { expanded, isMobile, mobileOpen, animate } = state;
  const overlay = isMobile && mobileOpen;
  const transition = animate ? `width ${SIDEBAR_TRANSITION_MS}ms ease` : 'none';
  const flowWidth = isMobile || !expanded ? SIDEBAR_RAIL_WIDTH : SIDEBAR_EXPANDED_WIDTH;
  const navWidth = expanded ? SIDEBAR_EXPANDED_WIDTH : SIDEBAR_RAIL_WIDTH;

  return (
    <>
      {/* In-flow slot: the page content sits beside it and resizes with it. Charts (ResponsiveContainer and the
          window-resize listeners) get one resize after the width transition, so none keeps the old width. */}
      <div
        data-testid="sidebar-slot"
        style={{ width: flowWidth, flexShrink: 0, transition }}
        onTransitionEnd={(e) => {
          if (e.propertyName === 'width' && e.target === e.currentTarget) window.dispatchEvent(new Event('resize'));
        }}
      >
        <nav
          id={SIDEBAR_ID}
          aria-label="Department navigation"
          style={{
            width: navWidth,
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--ps-color-nav-rail-bg)',
            height: '100vh',
            position: overlay ? 'fixed' : 'sticky',
            top: 0,
            insetInlineStart: overlay ? 0 : undefined,
            zIndex: overlay ? 60 : 45,
            boxShadow: overlay ? '0 0 32px rgba(0,0,0,0.45)' : undefined,
            transition,
            overflow: 'hidden',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', flex: 1, padding: '16px 12px', gap: 4, overflowY: 'auto', overflowX: 'hidden' }}>
            <SidebarItem href="/" label="Home" icon={Home} active={pathname === '/'} expanded={expanded} />

            <div aria-hidden style={{ height: 1, background: 'rgba(255,255,255,0.12)', margin: '8px 4px 12px' }} />

            {/* Same rule as the hub page: a department with built reports, none of which this user can view, is
                hidden; not-yet-built departments still show their "Coming soon" page. */}
            {DEPARTMENTS.filter((d) => !departmentIsBuilt(d.key) || departmentReports(d.key, canView).length > 0).map((dept) => (
              <SidebarItem
                key={dept.key}
                href={dept.href}
                label={dept.pTerm}
                icon={dept.icon}
                active={pathname === dept.href || pathname.startsWith(`${dept.href}/`)}
                expanded={expanded}
                accent={dept.accent}
              />
            ))}
          </div>

          {adminHref !== null && (
            <div style={{ padding: '0 12px 12px', borderTop: '1px solid rgba(255,255,255,0.12)', marginTop: 4 }}>
              <div style={{ paddingTop: 12 }}>
                <SidebarItem
                  href={adminHref ?? ADMIN_NAV_ITEM.href}
                  label={ADMIN_NAV_ITEM.label}
                  icon={ADMIN_NAV_ITEM.icon}
                  active={pathname.startsWith('/admin')}
                  expanded={expanded}
                />
              </div>
            </div>
          )}

          <SidebarToggleButton
            state={state}
            testId="sidebar-toggle"
            className="ps-sidebar-toggle"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: expanded ? 'flex-end' : 'center',
              border: 'none',
              borderTop: '1px solid rgba(255,255,255,0.12)',
              background: 'transparent',
              color: 'var(--ps-color-nav-rail-icon)',
              padding: '14px 16px',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          />
        </nav>
      </div>

      {overlay && (
        <div
          data-testid="sidebar-backdrop"
          aria-hidden
          onClick={state.closeMobile}
          style={{ position: 'fixed', inset: 0, zIndex: 59, background: 'rgba(0,0,0,0.45)' }}
        />
      )}
    </>
  );
}

/** « / » toggle -- the sidebar footer and the top bar both render this, so they always agree. */
export function SidebarToggleButton({
  state,
  testId,
  className,
  style,
}: {
  state: SidebarState;
  testId?: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const Icon = state.expanded ? ChevronsLeft : ChevronsRight;
  return (
    <button
      type="button"
      onClick={state.toggle}
      aria-label={state.expanded ? 'Collapse sidebar' : 'Expand sidebar'}
      aria-expanded={state.expanded}
      aria-controls={SIDEBAR_ID}
      aria-keyshortcuts="Control+B"
      title={state.expanded ? 'Collapse sidebar (Ctrl+B)' : 'Expand sidebar (Ctrl+B)'}
      data-testid={testId}
      className={className}
      style={style}
    >
      <Icon size={18} className="ps-rtl-flip" aria-hidden />
    </button>
  );
}

/** Rendered outside a SidebarProvider (not expected, kept so the sidebar never crashes): plain local expand state. */
function useFallbackState(): SidebarState {
  const [expanded, setExpanded] = useState(true);
  return {
    expanded,
    isMobile: false,
    collapsed: !expanded,
    mobileOpen: false,
    animate: true,
    toggle: () => setExpanded((e) => !e),
    closeMobile: () => undefined,
  };
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
  // Icon-only rail: the page name appears beside the icon on hover and keyboard focus. Fixed position, so the
  // sidebar's own overflow does not clip it; placed on the content side of the rail in both LTR and RTL.
  const [tip, setTip] = useState<{ top: number; x: number; rtl: boolean } | null>(null);
  const showTip = (el: HTMLElement) => {
    if (expanded) return;
    const r = el.getBoundingClientRect();
    const rtl = getComputedStyle(el).direction === 'rtl';
    setTip({ top: r.top + r.height / 2, x: rtl ? r.left - 10 : r.right + 10, rtl });
  };
  return (
    <Link
      href={href}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      className="ps-sidebar-item"
      onMouseEnter={(e) => showTip(e.currentTarget)}
      onMouseLeave={() => setTip(null)}
      onFocus={(e) => showTip(e.currentTarget)}
      onBlur={() => setTip(null)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        height: 44,
        flexShrink: 0,
        padding: '0 10px',
        borderRadius: 10,
        textDecoration: 'none',
        background: active ? (accent ? `color-mix(in srgb, ${accent} 28%, transparent)` : 'var(--ps-color-nav-rail-active-bg)') : 'transparent',
        color: active ? 'var(--ps-color-nav-rail-icon-active)' : 'var(--ps-color-nav-rail-icon)',
        boxShadow: active && !expanded ? 'inset 0 0 0 1px rgba(255,255,255,0.25)' : undefined,
        transition: 'background 0.15s ease, color 0.15s ease',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
      }}
    >
      <span style={{ display: 'inline-flex', flexShrink: 0 }}>
        <Icon size={19} />
      </span>
      {expanded && <span style={{ fontSize: 13.5, fontWeight: active ? 700 : 600 }}>{label}</span>}
      {tip && !expanded && (
        <span
          role="tooltip"
          data-testid="sidebar-tooltip"
          style={{
            position: 'fixed',
            top: tip.top,
            left: tip.x,
            transform: `translate(${tip.rtl ? '-100%' : '0'}, -50%)`,
            zIndex: 70,
            pointerEvents: 'none',
            padding: '6px 10px',
            borderRadius: 8,
            fontSize: 12.5,
            fontWeight: 600,
            background: 'var(--ps-color-surface)',
            color: 'var(--ps-color-text)',
            border: '1px solid var(--ps-color-border)',
            boxShadow: 'var(--ps-card-shadow)',
          }}
        >
          {label}
        </span>
      )}
    </Link>
  );
}
