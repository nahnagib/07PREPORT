import { describe, expect, it } from 'vitest';
import type { PermissionRegistryEntry } from '../api';
import { columnState, rowState, toggleCell, toggleColumn, toggleRow } from '../rolePermissions';

const revenue: PermissionRegistryEntry = { key: 'revenue_trend', label: 'Revenue Trend', group: 'dashboard', actions: ['view', 'export'] };
const tacho: PermissionRegistryEntry = { key: 'tachometer', label: 'Tachometer', group: 'dashboard', actions: ['view', 'export'] };
const companies: PermissionRegistryEntry = {
  key: 'admin_companies',
  label: 'Companies',
  group: 'admin',
  actions: ['view', 'create', 'edit', 'delete'],
};
const users: PermissionRegistryEntry = { key: 'admin_users', label: 'Users', group: 'admin', actions: ['view', 'create', 'edit'] };

describe('role permission matrix rules', () => {
  it('checking another action also checks View', () => {
    expect(toggleCell({}, companies, 'edit', true)).toEqual({ admin_companies: ['view', 'edit'] });
    expect(toggleCell({}, revenue, 'export', true)).toEqual({ revenue_trend: ['view', 'export'] });
  });

  it('unchecking View clears the whole row', () => {
    const set = { admin_companies: ['view', 'create', 'delete'] as const };
    expect(toggleCell({ ...set, admin_companies: [...set.admin_companies] }, companies, 'view', false)).toEqual({});
  });

  it('unchecking another action keeps View', () => {
    expect(toggleCell({ admin_companies: ['view', 'edit'] }, companies, 'edit', false)).toEqual({ admin_companies: ['view'] });
  });

  it('ignores actions a page does not have', () => {
    expect(toggleCell({}, revenue, 'delete', true)).toEqual({});
    expect(toggleCell({}, users, 'delete', true)).toEqual({});
  });

  it('row select-all sets every action of that page, and clears it', () => {
    const all = toggleRow({}, companies, true);
    expect(all).toEqual({ admin_companies: ['view', 'create', 'edit', 'delete'] });
    expect(rowState(all, companies)).toBe('all');
    expect(toggleRow(all, companies, false)).toEqual({});
  });

  it('column select-all applies only where the action exists, and implies View', () => {
    const set = toggleColumn({}, [companies, users], 'delete', true);
    expect(set).toEqual({ admin_companies: ['view', 'delete'] });
    expect(columnState(set, [companies, users], 'delete')).toBe('all');
    expect(columnState(set, [companies, users], 'view')).toBe('some');
    expect(columnState(set, [revenue, tacho], 'delete')).toBeNull();
  });

  it('column View off clears every row in the group', () => {
    const set = toggleColumn({ revenue_trend: ['view', 'export'], tachometer: ['view'] }, [revenue, tacho], 'view', false);
    expect(set).toEqual({});
  });

  it('row state is some when only part of a row is set', () => {
    expect(rowState({ admin_companies: ['view'] }, companies)).toBe('some');
    expect(rowState({}, companies)).toBe('none');
  });
});
