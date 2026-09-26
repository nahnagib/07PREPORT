import { describe, expect, it } from 'vitest';
import {
  PERMISSION_REGISTRY,
  getRegistryEntry,
  isRegisteredAction,
  normalizePageActions,
} from '../../config/permissionRegistry';
import { allows, canViewAnyDashboard, computeEffectivePermissions } from '../permissionService';
import { normalizePermissionSet, roleCodeFromLabel } from '../roleService';

describe('permission registry', () => {
  it('has unique page keys, and every page supports View', () => {
    const keys = PERMISSION_REGISTRY.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const e of PERMISSION_REGISTRY) expect(e.actions, e.key).toContain('view');
  });

  it('gives dashboards exactly View + Export (no Create/Delete on a report)', () => {
    for (const e of PERMISSION_REGISTRY.filter((x) => x.group === 'dashboard')) {
      expect([...e.actions].sort(), e.key).toEqual(['export', 'view']);
    }
  });

  it('knows which actions each page has', () => {
    expect(isRegisteredAction('admin_companies', 'delete')).toBe(true);
    expect(isRegisteredAction('admin_users', 'delete')).toBe(false); // users are disabled, never deleted
    expect(isRegisteredAction('revenue_trend', 'create')).toBe(false);
    expect(isRegisteredAction('no_such_page', 'view')).toBe(false);
    expect(getRegistryEntry('revenue_trend')?.group).toBe('dashboard');
  });

  it('normalizes an action set: drops inapplicable actions and implies View', () => {
    expect(normalizePageActions('revenue_trend', ['export'])).toEqual(['view', 'export']);
    expect(normalizePageActions('revenue_trend', ['create', 'delete'])).toEqual([]);
    expect(normalizePageActions('admin_companies', ['delete', 'create'])).toEqual(['view', 'create', 'delete']);
    expect(normalizePageActions('no_such_page', ['view'])).toEqual([]);
  });
});

describe('computeEffectivePermissions', () => {
  const grant = (page_key: string, action: string, allowed = 1) => ({ page_key, action: action as never, allowed });

  it('combines several roles as a union', () => {
    const p = computeEffectivePermissions({
      isAdmin: false,
      roleGrants: [grant('revenue_trend', 'view'), grant('tachometer', 'view'), grant('tachometer', 'export')],
      overrides: [],
    });
    expect(allows(p, 'revenue_trend', 'view')).toBe(true);
    expect(allows(p, 'revenue_trend', 'export')).toBe(false);
    expect(allows(p, 'tachometer', 'export')).toBe(true);
    expect(allows(p, 'critical_number', 'view')).toBe(false);
  });

  it('an explicit deny from one role does not cancel an allow from another', () => {
    const p = computeEffectivePermissions({
      isAdmin: false,
      roleGrants: [grant('revenue_trend', 'view', 0), grant('revenue_trend', 'view', 1)],
      overrides: [],
    });
    expect(allows(p, 'revenue_trend', 'view')).toBe(true);
  });

  it('a per-user override wins over every role', () => {
    const p = computeEffectivePermissions({
      isAdmin: false,
      roleGrants: [grant('revenue_trend', 'view'), grant('revenue_trend', 'export')],
      overrides: [grant('revenue_trend', 'export', 0), grant('tachometer', 'view', 1)],
    });
    expect(allows(p, 'revenue_trend', 'export')).toBe(false);
    expect(allows(p, 'tachometer', 'view')).toBe(true);
  });

  it('every action requires View on the page', () => {
    const p = computeEffectivePermissions({
      isAdmin: false,
      roleGrants: [grant('admin_companies', 'edit'), grant('revenue_trend', 'export')],
      overrides: [],
    });
    expect(allows(p, 'admin_companies', 'edit')).toBe(false);
    expect(allows(p, 'revenue_trend', 'export')).toBe(false);
  });

  it('ignores stored rows for actions the registry does not list for that page', () => {
    const p = computeEffectivePermissions({
      isAdmin: false,
      roleGrants: [grant('admin_login_history', 'view'), grant('admin_login_history', 'export')],
      overrides: [],
    });
    expect(allows(p, 'admin_login_history', 'view')).toBe(true);
    expect(allows(p, 'admin_login_history', 'export')).toBe(false);
  });

  it('Admin gets every registered action on every page, and nothing unregistered', () => {
    const p = computeEffectivePermissions({ isAdmin: true, roleGrants: [], overrides: [grant('tachometer', 'view', 0)] });
    for (const e of PERMISSION_REGISTRY) for (const a of e.actions) expect(allows(p, e.key, a), `${e.key}/${a}`).toBe(true);
    expect(allows(p, 'admin_users', 'delete')).toBe(false);
  });

  it('canViewAnyDashboard: true with one dashboard, false with admin pages only', () => {
    const viewer = computeEffectivePermissions({ isAdmin: false, roleGrants: [grant('revenue_trend', 'view')], overrides: [] });
    const adminOnly = computeEffectivePermissions({ isAdmin: false, roleGrants: [grant('admin_users', 'view')], overrides: [] });
    expect(canViewAnyDashboard(viewer)).toBe(true);
    expect(canViewAnyDashboard(adminOnly)).toBe(false);
  });
});

describe('role helpers', () => {
  it('derives a C_-prefixed code that cannot collide with a built-in role code', () => {
    expect(roleCodeFromLabel('Viewer – Revenue only')).toBe('C_VIEWER_REVENUE_ONLY');
    expect(roleCodeFromLabel('Admin')).toBe('C_ADMIN');
    expect(roleCodeFromLabel('عارض')).toBe('C_ROLE');
    expect(roleCodeFromLabel('x'.repeat(80)).length).toBeLessThanOrEqual(30);
  });

  it('normalizePermissionSet keeps only registered page/actions and implies View', () => {
    expect(
      normalizePermissionSet({ revenue_trend: ['export'], admin_roles: ['delete'], nope: ['view'], tachometer: ['create'] }),
    ).toEqual({ revenue_trend: ['view', 'export'], admin_roles: ['view', 'delete'] });
    expect(normalizePermissionSet({ revenue_trend: ['export'] }, { dropViewless: true })).toEqual({});
  });
});
