'use client';
import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useAuth } from '../lib/AuthProvider';

/**
 * One sidebar state for every screen size (2026-11-02). Desktop: expanded (240px) or collapsed to an icon rail (64px),
 * remembered per user. Small screens (< 768px): the 64px rail stays in place and "open" lays the full sidebar over the
 * page; it closes after a page is picked, on a tap outside it, or on Escape. The same toggle (sidebar footer, top bar
 * next to the logo, Ctrl+B) drives both, so there is one implementation, not a desktop and a mobile copy.
 */
export const SIDEBAR_EXPANDED_WIDTH = 240;
export const SIDEBAR_RAIL_WIDTH = 64;
export const SIDEBAR_TRANSITION_MS = 200;
export const SIDEBAR_ID = 'ps-department-sidebar';
export const MOBILE_QUERY = '(max-width: 767px)';

const DEVICE_KEY = 'ps.sidebar.collapsed';
const userKey = (userId: number) => `${DEVICE_KEY}.u${userId}`;

/** localStorage can throw (private mode, blocked site data) or be empty -- the sidebar then just uses its default. */
export function readCollapsed(key: string): boolean | null {
  try {
    const v = window.localStorage.getItem(key);
    return v === '1' ? true : v === '0' ? false : null;
  } catch {
    return null;
  }
}
function writeCollapsed(key: string, collapsed: boolean): void {
  try {
    window.localStorage.setItem(key, collapsed ? '1' : '0');
  } catch {
    /* not persisted -- the choice still holds for this page view */
  }
}

/** Ctrl+B (Cmd+B on a Mac), but not while typing in a field, where it may mean bold. */
export function isSidebarShortcut(e: KeyboardEvent): boolean {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'b') return false;
  const t = e.target as HTMLElement | null;
  return !(t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)));
}

export interface SidebarState {
  /** Labels visible: desktop not collapsed, or the small-screen overlay open. */
  expanded: boolean;
  isMobile: boolean;
  /** Desktop choice (the rail), kept while the screen is small. */
  collapsed: boolean;
  mobileOpen: boolean;
  /** False until the saved choice is applied, so the first paint does not animate from the default. */
  animate: boolean;
  toggle: () => void;
  closeMobile: () => void;
}

const SidebarContext = createContext<SidebarState | null>(null);

/** null outside a page with the department sidebar (Hub, Admin) -- callers then show no sidebar toggle. */
export function useSidebar(): SidebarState | null {
  return useContext(SidebarContext);
}

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [collapsed, setCollapsed] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [animate, setAnimate] = useState(false);

  // Before the first paint: screen size, then this device's last choice (default: rail below 1024px, as before).
  useIsoLayoutEffect(() => {
    const mq = window.matchMedia?.(MOBILE_QUERY);
    setIsMobile(!!mq?.matches);
    setCollapsed(readCollapsed(DEVICE_KEY) ?? window.innerWidth < 1024);
    const id = window.requestAnimationFrame(() => setAnimate(true));
    const onChange = (e: MediaQueryListEvent) => {
      setIsMobile(e.matches);
      setMobileOpen(false);
    };
    mq?.addEventListener?.('change', onChange);
    return () => {
      window.cancelAnimationFrame(id);
      mq?.removeEventListener?.('change', onChange);
    };
  }, []);

  // Once the user is known, their own saved choice wins over the device's.
  useEffect(() => {
    if (userId == null) return;
    const saved = readCollapsed(userKey(userId));
    if (saved != null) setCollapsed(saved);
  }, [userId]);

  // Small screens: picking a page closes the overlay.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  const toggle = useCallback(() => {
    if (isMobile) {
      setMobileOpen((o) => !o);
      return;
    }
    setCollapsed((c) => {
      const next = !c;
      writeCollapsed(DEVICE_KEY, next);
      if (userId != null) writeCollapsed(userKey(userId), next);
      return next;
    });
  }, [isMobile, userId]);
  const closeMobile = useCallback(() => setMobileOpen(false), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isSidebarShortcut(e)) {
        e.preventDefault();
        toggle();
      } else if (e.key === 'Escape' && mobileOpen) {
        setMobileOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle, mobileOpen]);

  const expanded = isMobile ? mobileOpen : !collapsed;
  // The width the sidebar takes in the page flow, for fixed elements beside it (the bottom page bar).
  const flowWidth = isMobile || collapsed ? SIDEBAR_RAIL_WIDTH : SIDEBAR_EXPANDED_WIDTH;
  useIsoLayoutEffect(() => {
    document.documentElement.style.setProperty('--ps-sidebar-width', `${flowWidth}px`);
    return () => {
      document.documentElement.style.removeProperty('--ps-sidebar-width');
    };
  }, [flowWidth]);

  const value = useMemo<SidebarState>(
    () => ({ expanded, isMobile, collapsed, mobileOpen, animate, toggle, closeMobile }),
    [expanded, isMobile, collapsed, mobileOpen, animate, toggle, closeMobile],
  );
  return <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>;
}
