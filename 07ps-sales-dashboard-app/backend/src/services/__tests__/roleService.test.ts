import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RoleInUseError, assertCanDeactivate, deleteRole, setUserRoles, updateRole } from '../roleService';

/**
 * The protections in roleService: they must hold for any caller (UI, API, script), so they're
 * tested at the service. A small fake answers pool.query by SQL shape; every scenario here is
 * refused before any write, so a write reaching the fake fails the test.
 */

interface FakeRole {
  role_id: number;
  role_name: string;
  role_label: string;
  is_system: number;
  default_role_tier_code: string;
}

const state = {
  roles: [] as FakeRole[],
  userRoles: [] as { user_id: number; role_id: number; status: string }[],
  primaries: new Map<number, number>(),
};

const queryMock = vi.fn(async (sql: string, params: unknown[] = []) => {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (s.includes('FROM roles r LEFT JOIN app_user cu')) {
    const id = Number(params[0]);
    const role = state.roles.find((r) => r.role_id === id);
    return [role ? [{ ...role, description: null, created_at: new Date(), updated_at: new Date(), created_by: null, created_by_name: null, user_count: state.userRoles.filter((u) => u.role_id === id).length }] : []];
  }
  if (s.startsWith('SELECT pg.page_key, p.action FROM role_permissions')) return [[{ page_key: 'revenue_trend', action: 'view' }]];
  if (s.startsWith('SELECT user_id FROM user_roles WHERE role_id = ?')) {
    return [state.userRoles.filter((u) => u.role_id === Number(params[0])).map((u) => ({ user_id: u.user_id }))];
  }
  if (s.startsWith('SELECT role_id, default_role_tier_code FROM roles WHERE role_id IN')) {
    const ids = (params[0] as number[]).map(Number);
    return [state.roles.filter((r) => ids.includes(r.role_id))];
  }
  if (s.startsWith('SELECT role_id FROM app_user WHERE user_id = ?')) {
    const id = Number(params[0]);
    return [state.primaries.has(id) ? [{ role_id: state.primaries.get(id) }] : []];
  }
  if (s.startsWith('SELECT role_id FROM user_roles WHERE user_id = ?')) {
    return [state.userRoles.filter((u) => u.user_id === Number(params[0])).map((u) => ({ role_id: u.role_id }))];
  }
  if (s.startsWith('SELECT role_id FROM roles WHERE role_name = ?')) {
    return [state.roles.filter((r) => r.role_name === params[0]).map((r) => ({ role_id: r.role_id }))];
  }
  if (s.startsWith('SELECT COUNT(*) AS n FROM user_roles ur JOIN app_user u')) {
    const [roleId, userId] = params.map(Number);
    const n = state.userRoles.filter(
      (u) => u.role_id === roleId && u.user_id !== userId && ['ACTIVE', 'PENDING_PASSWORD_CHANGE'].includes(u.status),
    ).length;
    return [[{ n }]];
  }
  if (s.startsWith('SELECT 1 FROM user_roles WHERE user_id = ? AND role_id = ?')) {
    const [userId, roleId] = params.map(Number);
    return [state.userRoles.some((u) => u.user_id === userId && u.role_id === roleId) ? [{ 1: 1 }] : []];
  }
  throw new Error(`Unexpected SQL in roleService test: ${s.slice(0, 140)}`);
});

vi.mock('../../db/pool', () => ({
  pool: {
    query: (sql: string, params?: unknown[]) => queryMock(sql, params),
    getConnection: async () => {
      throw new Error('No write should be attempted in these scenarios.');
    },
  },
}));
const auditMock = vi.fn();
vi.mock('../auditLogService', () => ({ writeAuditLog: (e: unknown) => auditMock(e) }));


const ADMIN: FakeRole = { role_id: 1, role_name: 'ADMIN', role_label: 'Admin', is_system: 1, default_role_tier_code: 'BI00_EXECUTIVE' };
const GCEO: FakeRole = { role_id: 2, role_name: 'GCEO', role_label: 'GCEO', is_system: 1, default_role_tier_code: 'BI00_EXECUTIVE' };
const CUSTOM: FakeRole = { role_id: 50, role_name: 'C_VIEWER', role_label: 'Viewer', is_system: 0, default_role_tier_code: 'BI00_EXECUTIVE' };

beforeEach(() => {
  vi.clearAllMocks();
  state.roles = [ADMIN, GCEO, CUSTOM];
  state.userRoles = [];
  state.primaries = new Map();
});

describe('the Admin role is locked', () => {
  it('cannot be renamed', async () => {
    await expect(updateRole(1, { label: 'Super' }, 7)).rejects.toThrow('cannot be renamed');
  });

  it('cannot have its permissions changed', async () => {
    await expect(updateRole(1, { permissions: { revenue_trend: ['view'] } }, 7)).rejects.toThrow('cannot be changed');
  });

  it('cannot have its data scope changed', async () => {
    await expect(updateRole(1, { tierCode: 'SALESPERSON' }, 7)).rejects.toThrow('data scope');
  });

  it('cannot be deleted (nor can any built-in role)', async () => {
    await expect(deleteRole(1, null, 7)).rejects.toThrow('Built-in roles cannot be deleted');
    await expect(deleteRole(2, null, 7)).rejects.toThrow('Built-in roles cannot be deleted');
  });
});

describe('deleting a custom role', () => {
  it('with users assigned and no replacement is refused with the user count', async () => {
    state.userRoles = [
      { user_id: 10, role_id: 50, status: 'ACTIVE' },
      { user_id: 11, role_id: 50, status: 'ACTIVE' },
    ];
    const err = await deleteRole(50, null, 7).catch((e) => e);
    expect(err).toBeInstanceOf(RoleInUseError);
    expect(err.userCount).toBe(2);
  });

  it('cannot use itself as the replacement', async () => {
    state.userRoles = [{ user_id: 10, role_id: 50, status: 'ACTIVE' }];
    await expect(deleteRole(50, 50, 7)).rejects.toThrow('different role');
  });
});

describe('the last active admin keeps the Admin role', () => {
  it('refuses to remove Admin from the only active admin', async () => {
    state.userRoles = [
      { user_id: 10, role_id: 1, status: 'ACTIVE' },
      { user_id: 11, role_id: 1, status: 'INACTIVE' }, // a disabled admin doesn't count
    ];
    state.primaries.set(10, 1);
    await expect(setUserRoles(10, [2], 10)).rejects.toThrow('last active Admin');
  });

  it('refuses to disable or lock the only active admin', async () => {
    state.userRoles = [{ user_id: 10, role_id: 1, status: 'ACTIVE' }];
    await expect(assertCanDeactivate(10)).rejects.toThrow('last active Admin');
  });

  it('allows disabling an admin when another active admin exists', async () => {
    state.userRoles = [
      { user_id: 10, role_id: 1, status: 'ACTIVE' },
      { user_id: 12, role_id: 1, status: 'ACTIVE' },
    ];
    await expect(assertCanDeactivate(10)).resolves.toBeUndefined();
  });
});

describe('setUserRoles input checks', () => {
  it('needs at least one role', async () => {
    await expect(setUserRoles(10, [], 7)).rejects.toThrow('at least one role');
  });

  it('rejects unknown roles', async () => {
    state.primaries.set(10, 2);
    await expect(setUserRoles(10, [2, 999], 7)).rejects.toThrow('Unknown role');
  });

  it('requires the primary role to be one of the assigned roles', async () => {
    state.primaries.set(10, 2);
    state.userRoles = [{ user_id: 10, role_id: 2, status: 'ACTIVE' }];
    await expect(setUserRoles(10, [2], 7, 50)).rejects.toThrow('primary role');
  });
});
