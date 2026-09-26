import type { PermissionAction, PermissionRegistryEntry, RolePermissionSet } from './api';

/**
 * Rules of the Roles screen's permission matrix, kept pure so they're unit-tested
 * (lib/__tests__/rolePermissions.test.ts):
 *
 *   - a page only offers the actions the registry lists for it;
 *   - checking any other action also checks View (you can't edit what you can't see);
 *   - unchecking View clears the whole row;
 *   - "select all" works per row (every action of that page) and per column (that action on every
 *     page of the group that has it -- plus View, by the first rule).
 *
 * The backend applies the same normalization (roleService.normalizePermissionSet), so these rules
 * hold however a role is saved.
 */

export type CheckState = 'all' | 'some' | 'none';

function withAction(actions: readonly PermissionAction[], add: PermissionAction[]): PermissionAction[] {
  const set = new Set([...actions, ...add]);
  return ['view', 'create', 'edit', 'delete', 'export'].filter((a) => set.has(a as PermissionAction)) as PermissionAction[];
}

export function hasAction(set: RolePermissionSet, pageKey: string, action: PermissionAction): boolean {
  return set[pageKey]?.includes(action) ?? false;
}

/** One cell toggled. */
export function toggleCell(
  set: RolePermissionSet,
  entry: PermissionRegistryEntry,
  action: PermissionAction,
  checked: boolean,
): RolePermissionSet {
  if (!entry.actions.includes(action)) return set;
  const next = { ...set };
  const current = next[entry.key] ?? [];
  if (checked) {
    next[entry.key] = withAction(current, action === 'view' ? ['view'] : ['view', action]);
  } else if (action === 'view') {
    delete next[entry.key];
  } else {
    const remaining = current.filter((a) => a !== action);
    if (remaining.length > 0) next[entry.key] = remaining;
    else delete next[entry.key];
  }
  return next;
}

/** A whole row (page) set to all of its actions, or cleared. */
export function toggleRow(set: RolePermissionSet, entry: PermissionRegistryEntry, checked: boolean): RolePermissionSet {
  const next = { ...set };
  if (checked) next[entry.key] = withAction([], [...entry.actions]);
  else delete next[entry.key];
  return next;
}

/** One action set/cleared on every page of `entries` that has it. */
export function toggleColumn(
  set: RolePermissionSet,
  entries: readonly PermissionRegistryEntry[],
  action: PermissionAction,
  checked: boolean,
): RolePermissionSet {
  let next = set;
  for (const e of entries) if (e.actions.includes(action)) next = toggleCell(next, e, action, checked);
  return next;
}

export function rowState(set: RolePermissionSet, entry: PermissionRegistryEntry): CheckState {
  const n = entry.actions.filter((a) => hasAction(set, entry.key, a)).length;
  return n === 0 ? 'none' : n === entry.actions.length ? 'all' : 'some';
}

export function columnState(
  set: RolePermissionSet,
  entries: readonly PermissionRegistryEntry[],
  action: PermissionAction,
): CheckState | null {
  const applicable = entries.filter((e) => e.actions.includes(action));
  if (applicable.length === 0) return null;
  const n = applicable.filter((e) => hasAction(set, e.key, action)).length;
  return n === 0 ? 'none' : n === applicable.length ? 'all' : 'some';
}

/** Count of granted page/actions, for the roles list summary. */
export function grantCount(set: RolePermissionSet): number {
  return Object.values(set).reduce((sum, actions) => sum + actions.length, 0);
}
