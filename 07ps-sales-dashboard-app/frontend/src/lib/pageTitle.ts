'use client';
import { useMemo } from 'react';
import { usePathname } from 'next/navigation';
import { ADMIN_TABS, NAV_ITEMS, SUB_PAGES } from './navItems';
import { DEPARTMENTS } from './departments';

/**
 * The header / browser-tab title, derived from the same nav config as the sidebar (DEPARTMENTS) and the bottom tab bar
 * (NAV_ITEMS, ADMIN_TABS): "<Department> — <Page>", plus " › <Sub page>" one level deeper. A new or renamed tab changes
 * the title by itself; no page hardcodes its own title.
 *
 *   /promotion/tachometer           Promotion — Tachometer
 *   /promotion/tachometer/ytdValue  Promotion — Tachometer › YTD Value Breakdown   (subTitle passed by the page)
 *   /promotion                      Promotion Dashboard                           (department hub)
 *   /admin/users                    Admin — Users
 *   /                               7Ps Dashboard Hub
 */
export interface PageTitle {
  /** Muted leading part (the department, or "Admin"); null on hubs. */
  context: string | null;
  /** The current page, shown bold. Never empty. */
  page: string;
  /** One level deeper (a sub-page or the record / metric shown), or null. */
  sub: string | null;
  /** The whole title as one line of text (also the browser tab title). */
  text: string;
}

export const HUB_TITLE = '7Ps Dashboard Hub';
export const APP_TITLE = 'BMH - 7Ps Dashboard';
const ADMIN = 'Admin';

const matches = (pathname: string, href: string) => pathname === href || pathname.startsWith(`${href}/`);

function longest<T extends { href: string }>(pathname: string, items: readonly T[]): T | undefined {
  let best: T | undefined;
  for (const item of items) if (matches(pathname, item.href) && (!best || item.href.length > best.href.length)) best = item;
  return best;
}

function build(context: string | null, page: string, sub: string | null): PageTitle {
  const text = `${context ? `${context} — ` : ''}${page}${sub ? ` › ${sub}` : ''}`;
  return { context, page, sub, text };
}

/** Pure resolver (unit-tested): `subTitle` overrides the sub-page level for records / metrics the nav config cannot know. */
export function resolvePageTitle(pathname: string | null | undefined, subTitle?: string | null): PageTitle {
  const path = (pathname || '/').replace(/\/+$/, '') || '/';
  const sub = subTitle?.trim() || longest(path, SUB_PAGES)?.label || null;
  if (path === '/') return build(null, HUB_TITLE, null);

  const item = longest(path, NAV_ITEMS);
  if (item) {
    const dept = DEPARTMENTS.find((d) => d.key === item.department);
    return build(dept?.pTerm ?? null, item.label, sub);
  }
  const tab = longest(path, ADMIN_TABS);
  if (tab) return build(ADMIN, tab.label, sub);

  const dept = DEPARTMENTS.find((d) => matches(path, d.href));
  if (dept && path === dept.href) return build(null, `${dept.pTerm} Dashboard`, null);

  // Not in the nav config: fall back to the department (or the app), never an empty title.
  if (process.env.NODE_ENV !== 'production') console.warn(`[pageTitle] no nav entry for "${path}"; add it to lib/navItems.ts`);
  if (dept) return build(null, `${dept.pTerm} Dashboard`, sub);
  if (path.startsWith('/admin')) return build(null, ADMIN, sub);
  return build(null, HUB_TITLE, sub);
}

/** The current route's title (see resolvePageTitle). */
export function usePageTitle(subTitle?: string | null): PageTitle {
  const pathname = usePathname();
  return useMemo(() => resolvePageTitle(pathname, subTitle), [pathname, subTitle]);
}
