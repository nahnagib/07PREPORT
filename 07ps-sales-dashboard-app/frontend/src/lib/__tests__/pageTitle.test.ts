import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolvePageTitle } from '../pageTitle';
import { ADMIN_TABS, NAV_ITEMS } from '../navItems';

const text = (path: string, sub?: string) => resolvePageTitle(path, sub).text;

afterEach(() => vi.restoreAllMocks());

describe('header title "<Department> — <Page>" from the nav config', () => {
  it('report pages', () => {
    expect(text('/promotion/tachometer')).toBe('Promotion — Tachometer');
    expect(text('/promotion/pipeline-health')).toBe('Promotion — Pipeline Health');
    expect(text('/promotion/marcom-spending')).toBe('Promotion — MARCOM Spending');
    expect(text('/product/bcg-matrix')).toBe('Product — BCG Matrix');
    expect(text('/price/receivables-collections')).toBe('Price — Receivables and Collections');
    expect(text('/process/nps-score')).toBe('Process — NPS Score');
    expect(text('/process/nps-score/')).toBe('Process — NPS Score');
  });

  it('splits the parts for styling: department muted, page bold', () => {
    expect(resolvePageTitle('/promotion/pipeline-health')).toEqual({ context: 'Promotion', page: 'Pipeline Health', sub: null, text: 'Promotion — Pipeline Health' });
  });

  it('admin pages', () => {
    expect(text('/admin/users')).toBe('Admin — Users');
    expect(text('/admin/etl-control')).toBe('Admin — ETL Control Center');
    expect(text('/admin/users/import')).toBe('Admin — Users › Excel Import');
    expect(text('/admin/users/12', 'User Details')).toBe('Admin — Users › User Details');
  });

  it('a deeper page adds one level: the page\'s subTitle, else the nav config\'s sub-page', () => {
    expect(text('/promotion/tachometer/ytdValue', 'YTD Value Breakdown')).toBe('Promotion — Tachometer › YTD Value Breakdown');
    expect(text('/process/kaizen-board/manage')).toBe('Process — Kaizen Board › Manage Kaizen Cards');
    expect(text('/process/kaizen-board/manage/new')).toBe('Process — Kaizen Board › New Kaizen Card');
    expect(text('/process/nps-followup/reasons')).toBe('Process — Detractor Follow-up › Reasons');
    expect(text('/product/pim-contribution/brand/xtreme')).toBe('Product — PIM Contribution › Brand Performance');
    expect(text('/product/pim-contribution/brand/xtreme', 'Brand Performance: Xtreme')).toBe('Product — PIM Contribution › Brand Performance: Xtreme');
  });

  it('hubs: the app hub and each department hub', () => {
    expect(text('/')).toBe('7Ps Dashboard Hub');
    expect(text('/promotion')).toBe('Promotion Dashboard');
    expect(text('/place')).toBe('Place Dashboard');
  });

  it('a route missing from the nav config falls back to its department (never empty) and warns in dev', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(text('/promotion/not-a-page')).toBe('Promotion Dashboard');
    expect(text('/somewhere/else')).toBe('7Ps Dashboard Hub');
    expect(text('/admin/etl-runs')).toBe('Admin');
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('every nav entry and admin tab resolves to its own label', () => {
    for (const item of NAV_ITEMS) expect(resolvePageTitle(item.href).page).toBe(item.label);
    for (const tab of ADMIN_TABS) expect(resolvePageTitle(tab.href).text).toBe(`Admin — ${tab.label}`);
  });
});
