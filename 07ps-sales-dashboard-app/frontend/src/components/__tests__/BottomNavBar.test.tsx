import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { BottomNavBar } from '../BottomNavBar';

const route = vi.hoisted(() => ({ pathname: '/promotion/sales-people-performance' }));
vi.mock('next/navigation', () => ({ usePathname: () => route.pathname }));
vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('../../lib/AuthProvider', () => ({ useAuth: () => ({ canView: () => true, isAdmin: false }) }));
// jsdom has no scrollIntoView (ScrollableNav scrolls the current tab into view).
Element.prototype.scrollIntoView = vi.fn();
afterEach(cleanup);

const current = () => screen.getAllByRole('link').filter((l) => l.getAttribute('aria-current') === 'page').map((l) => l.getAttribute('aria-label'));

describe('BottomNavBar active tab', () => {
  it('without a label, highlights the page of the current route, not Tachometer', () => {
    render(<BottomNavBar />);
    expect(current()).toEqual(['Sales People Performance']);
  });
  it('an explicit label still wins', () => {
    route.pathname = '/promotion/tachometer/value';
    render(<BottomNavBar active="Tachometer" />);
    expect(current()).toEqual(['Tachometer']);
  });
});
