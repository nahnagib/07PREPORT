import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const nav = vi.hoisted(() => ({ pathname: '/promotion/pipeline-health' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('../../lib/AuthProvider', () => ({ useAuth: () => ({ canView: () => true, isAdmin: true, user: { id: 7 } }) }));

import { DepartmentSidebar, SidebarToggleButton } from '../DepartmentSidebar';
import { SidebarProvider, isSidebarShortcut, useSidebar } from '../SidebarProvider';

function HeaderToggle() {
  const s = useSidebar();
  return s ? <SidebarToggleButton state={s} testId="header-toggle" /> : null;
}
function Shell() {
  return (
    <SidebarProvider>
      <HeaderToggle />
      <DepartmentSidebar />
      <input aria-label="search" />
    </SidebarProvider>
  );
}

function setViewport(width: number, mobile: boolean) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: mobile,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

const toggle = () => screen.getByTestId('sidebar-toggle');
const slotWidth = () => screen.getByTestId('sidebar-slot').style.width;

beforeEach(() => {
  window.localStorage.clear();
  nav.pathname = '/promotion/pipeline-health';
  setViewport(1920, false);
});
afterEach(() => cleanup());

describe('desktop sidebar collapse', () => {
  it('collapses to a 64px icon rail and back, with a real button (aria-expanded, aria-controls)', () => {
    render(<Shell />);
    expect(toggle()).toHaveProperty('tagName', 'BUTTON');
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(toggle().getAttribute('aria-controls')).toBe('ps-department-sidebar');
    expect(slotWidth()).toBe('240px');
    expect(screen.getByText('Promotion')).toBeTruthy();

    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(toggle().getAttribute('aria-label')).toBe('Expand sidebar');
    expect(slotWidth()).toBe('64px');
    expect(screen.queryByText('Promotion')).toBeNull(); // icons only
    expect(document.documentElement.style.getPropertyValue('--ps-sidebar-width')).toBe('64px');
  });

  it('the top-bar toggle and the sidebar toggle share one state', () => {
    render(<Shell />);
    fireEvent.click(screen.getByTestId('header-toggle'));
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(screen.getByTestId('header-toggle'));
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
  });

  it('remembers the choice per user and restores it after a reload', () => {
    const first = render(<Shell />);
    fireEvent.click(toggle());
    expect(window.localStorage.getItem('ps.sidebar.collapsed.u7')).toBe('1');
    first.unmount();
    render(<Shell />);
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(slotWidth()).toBe('64px');
  });

  it('keeps working when localStorage throws', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    render(<Shell />);
    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    get.mockRestore();
    set.mockRestore();
  });

  it('Ctrl+B toggles it, but not while typing in a field', () => {
    render(<Shell />);
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true });
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(screen.getByLabelText('search'), { key: 'b', ctrlKey: true });
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(isSidebarShortcut(new KeyboardEvent('keydown', { key: 'B', ctrlKey: true }))).toBe(true);
    expect(isSidebarShortcut(new KeyboardEvent('keydown', { key: 'b' }))).toBe(false);
  });

  it('collapsed: hovering an icon shows the page name, and the active page stays marked', () => {
    render(<Shell />);
    fireEvent.click(toggle());
    const promotion = screen.getByLabelText('Promotion');
    expect(promotion.getAttribute('aria-current')).toBe('page');
    fireEvent.mouseEnter(promotion);
    expect(screen.getByTestId('sidebar-tooltip').textContent).toBe('Promotion');
    fireEvent.mouseLeave(promotion);
    expect(screen.queryByTestId('sidebar-tooltip')).toBeNull();
  });

  it('fires one window resize after the width transition, so charts take the new width', () => {
    render(<Shell />);
    const onResize = vi.fn();
    window.addEventListener('resize', onResize);
    fireEvent.click(toggle());
    const slot = screen.getByTestId('sidebar-slot');
    const end = new Event('transitionend', { bubbles: true }) as Event & { propertyName?: string };
    Object.defineProperty(end, 'propertyName', { value: 'width' });
    act(() => {
      slot.dispatchEvent(end);
    });
    expect(onResize).toHaveBeenCalledTimes(1);
    window.removeEventListener('resize', onResize);
  });
});

describe('small screens (same component and state)', () => {
  beforeEach(() => setViewport(390, true));

  it('opens over the page and closes on a tap outside, after picking a page, and on Escape', () => {
    const view = render(<Shell />);
    expect(slotWidth()).toBe('64px');
    expect(toggle().getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(slotWidth()).toBe('64px'); // the page does not move; the sidebar lies over it
    expect(document.getElementById('ps-department-sidebar')?.style.position).toBe('fixed');
    fireEvent.click(screen.getByTestId('sidebar-backdrop'));
    expect(toggle().getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(toggle());
    nav.pathname = '/price/receivables-collections';
    view.rerender(<Shell />);
    expect(toggle().getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(toggle());
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
  });

  it('does not overwrite the saved desktop choice', () => {
    render(<Shell />);
    fireEvent.click(toggle());
    expect(window.localStorage.getItem('ps.sidebar.collapsed.u7')).toBeNull();
  });
});
