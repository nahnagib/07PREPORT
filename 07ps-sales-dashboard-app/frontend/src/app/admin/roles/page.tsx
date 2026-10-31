'use client';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Lock, Pencil, Plus, Trash2, X } from 'lucide-react';
import { Button, Card, EmptyState, ErrorState, LoadingSkeleton, Select, TextInput } from '@07ps/ui';
import { AdminLayout } from '../../../components/AdminLayout';
import { PermissionGuard } from '../../../components/AuthGuard';
import { useAuth } from '../../../lib/AuthProvider';
import {
  adminApi,
  ApiError,
  DataScopeOperator,
  DataScopeRule,
  DataScopeValue,
  PermissionAction,
  PermissionRegistryEntry,
  RoleDetail,
  RolePermissionSet,
  RolesAdminView,
  RoleSummary,
} from '../../../lib/api';
import { formatDate as formatDisplayDate } from '../../../lib/format';
import { OPERATOR_HINT, OPERATOR_LABEL, scopeSummary } from '../../../lib/dataScope';
import { ScopeValuePicker } from '../../../components/admin/ScopeValuePicker';
import { useDimensionValues } from '../../../lib/useDimensionValues';
import { CheckState, columnState, hasAction, rowState, toggleCell, toggleColumn, toggleRow } from '../../../lib/rolePermissions';

const ACTION_LABEL: Record<PermissionAction, string> = {
  view: 'View',
  create: 'Create',
  edit: 'Edit',
  delete: 'Delete',
  export: 'Export',
};
const ACTIONS: PermissionAction[] = ['view', 'create', 'edit', 'delete', 'export'];

function formatDate(iso: string): string {
  return formatDisplayDate(iso);
}

export default function AdminRolesPage() {
  return (
    <PermissionGuard pageKey="admin_roles">
      <AdminLayout>
        <RolesBody />
      </AdminLayout>
    </PermissionGuard>
  );
}

type EditorState = { mode: 'create' } | { mode: 'edit'; roleId: number } | null;

function RolesBody() {
  const { token, canCreate, canEdit, canDelete } = useAuth();
  const [view, setView] = useState<RolesAdminView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyRoleId, setBusyRoleId] = useState<number | null>(null);
  const [editor, setEditor] = useState<EditorState>(null);
  const [deleting, setDeleting] = useState<RoleSummary | null>(null);

  const mayCreate = canCreate('admin_roles');
  const mayEdit = canEdit('admin_roles');
  const mayDelete = canDelete('admin_roles');

  const load = useCallback(() => {
    if (!token) return;
    setLoading(true);
    setError(null);
    adminApi
      .getRolesAdmin(token)
      .then(setView)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load roles.'))
      .finally(() => setLoading(false));
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleDuplicate(role: RoleSummary) {
    if (!token) return;
    setBusyRoleId(role.role_id);
    setNotice(null);
    setError(null);
    try {
      const { role: copy } = await adminApi.duplicateRole(token, role.role_id);
      setNotice(`Created "${copy.role_label}" with the same permissions. Adjust it below if needed.`);
      load();
      setEditor({ mode: 'edit', roleId: copy.role_id });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to duplicate role.');
    } finally {
      setBusyRoleId(null);
    }
  }

  if (loading && !view) return <LoadingSkeleton variant="kpi" />;
  if (error && !view) return <ErrorState message={error} onRetry={load} />;
  if (!view) return <EmptyState message="No roles configured." />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-4, 24px)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <p style={{ fontSize: 13, color: 'var(--ps-color-muted-text)', margin: 0, maxWidth: 720 }}>
          A role is a set of permissions per page. A user can hold several roles and gets everything any of them allows.
          Built-in roles can&apos;t be deleted; the Admin role always has full access.
        </p>
        {mayCreate && (
          <Button onClick={() => setEditor({ mode: 'create' })} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Plus size={14} /> Create role
          </Button>
        )}
      </div>

      {notice && <div className="ps-admin-notice">{notice}</div>}
      {error && <ErrorState message={error} onRetry={() => setError(null)} />}

      <Card>
        <div style={{ overflowX: 'auto' }}>
          <table className="ps-admin-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Description</th>
                <th style={{ textAlign: 'end' }}>Users</th>
                <th>Updated</th>
                <th style={{ textAlign: 'end' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {view.roles.map((role) => {
                const busy = busyRoleId === role.role_id;
                return (
                  <tr key={role.role_id} className="ps-datatable-row">
                    <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
                      <span dir="auto">{role.role_label}</span>
                      {role.is_system && (
                        <span className="ps-lock-badge" title={role.is_admin ? 'Built-in super administrator: locked' : 'Built-in role: cannot be deleted'}>
                          <Lock size={10} aria-hidden /> {role.is_admin ? 'Super admin' : 'Built-in'}
                        </span>
                      )}
                    </td>
                    <td dir="auto" style={{ color: 'var(--ps-color-muted-text)', minWidth: 220 }}>
                      {role.description || '—'}
                    </td>
                    <td style={{ textAlign: 'end', fontVariantNumeric: 'tabular-nums' }}>{role.user_count}</td>
                    <td style={{ whiteSpace: 'nowrap' }} title={`Created ${formatDate(role.created_at)}${role.created_by_name ? ` by ${role.created_by_name}` : ''}`}>
                      {formatDate(role.updated_at)}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                        <Button
                          variant="secondary"
                          disabled={busy}
                          onClick={() => setEditor({ mode: 'edit', roleId: role.role_id })}
                          style={{ padding: '4px 8px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}
                        >
                          <Pencil size={12} /> {mayEdit && !role.is_admin ? 'Edit' : 'View'}
                        </Button>
                        {mayCreate && (
                          <Button
                            variant="secondary"
                            disabled={busy}
                            onClick={() => handleDuplicate(role)}
                            style={{ padding: '4px 8px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}
                          >
                            <Copy size={12} /> Duplicate
                          </Button>
                        )}
                        {mayDelete && !role.is_system && (
                          <Button
                            variant="secondary"
                            disabled={busy}
                            onClick={() => setDeleting(role)}
                            style={{ padding: '4px 8px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--ps-color-alert)' }}
                          >
                            <Trash2 size={12} /> Delete
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {editor && (
        <RoleEditor
          key={editor.mode === 'edit' ? editor.roleId : 'new'}
          state={editor}
          view={view}
          readOnlyForUser={editor.mode === 'edit' && !mayEdit}
          onClose={() => setEditor(null)}
          onSaved={(message) => {
            setEditor(null);
            setNotice(message);
            load();
          }}
          onDataScopeChange={(dataScope) => setView((v) => (v ? { ...v, dataScope } : v))}
        />
      )}

      {deleting && (
        <DeleteRoleDialog
          role={deleting}
          roles={view.roles}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setNotice(`Deleted "${deleting.role_label}".`);
            setDeleting(null);
            load();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modal shell (Esc / X / click outside close it)
// ---------------------------------------------------------------------------

function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [onClose]);
  return (
    <div
      className="ps-modal-scrim"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="ps-modal" role="dialog" aria-modal="true" aria-label={title} style={{ maxWidth: wide ? 980 : 520 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }} dir="auto">
            {title}
          </h2>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close" className="ps-cn-icon-btn">
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create / edit role
// ---------------------------------------------------------------------------

function RoleEditor({
  state,
  view,
  readOnlyForUser,
  onClose,
  onSaved,
  onDataScopeChange,
}: {
  state: Exclude<EditorState, null>;
  view: RolesAdminView;
  readOnlyForUser: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
  onDataScopeChange: (dataScope: Record<number, DataScopeRule[]>) => void;
}) {
  const { token } = useAuth();
  const [detail, setDetail] = useState<RoleDetail | null>(null);
  const [loading, setLoading] = useState(state.mode === 'edit');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [tierCode, setTierCode] = useState('BI00_EXECUTIVE');
  const [permissions, setPermissions] = useState<RolePermissionSet>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (state.mode !== 'edit' || !token) return;
    adminApi
      .getRole(token, state.roleId)
      .then(({ role }) => {
        setDetail(role);
        setName(role.role_label);
        setDescription(role.description ?? '');
        setTierCode(role.default_role_tier_code ?? 'BI00_EXECUTIVE');
        setPermissions(role.permissions);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load role.'))
      .finally(() => setLoading(false));
  }, [state, token]);

  const isAdminRole = detail?.is_admin ?? false;
  const locked = isAdminRole || readOnlyForUser;
  const title = state.mode === 'create' ? 'Create role' : `${locked ? 'View' : 'Edit'} role: ${detail?.role_label ?? ''}`;

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!token || locked) return;
    setSaving(true);
    setError(null);
    try {
      const input = { name: name.trim(), description: description.trim() || null, tierCode, permissions };
      if (state.mode === 'create') {
        const { role } = await adminApi.createRole(token, input);
        onSaved(`Created "${role.role_label}".`);
      } else {
        const { role } = await adminApi.updateRole(token, state.roleId, input);
        onSaved(`Saved "${role.role_label}". Users with this role get the change on their next page load.`);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save role.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={title} onClose={onClose} wide>
      {loading ? (
        <LoadingSkeleton variant="kpi" />
      ) : (
        <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {isAdminRole && (
            <div className="ps-admin-notice" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Lock size={14} aria-hidden /> The Admin role is the built-in super administrator: it always has every permission
              and can&apos;t be renamed, restricted or deleted.
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
            <TextInput label="Name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} disabled={locked || saving} dir="auto" />
            <div>
              <label className="ps-admin-label" htmlFor="role-tier">
                Data scope
              </label>
              <select
                id="role-tier"
                className="ps-admin-select"
                value={tierCode}
                onChange={(e) => setTierCode(e.target.value)}
                disabled={locked || saving}
              >
                {view.tiers.map((t) => (
                  <option key={t.role_code} value={t.role_code}>
                    {t.role_label}
                  </option>
                ))}
              </select>
              <p style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', margin: '4px 0 0' }}>
                {view.tiers.find((t) => t.role_code === tierCode)?.scope_description ?? ''} Applies to users whose primary role
                this is.
              </p>
            </div>
          </div>
          <div>
            <label className="ps-admin-label" htmlFor="role-description">
              Description
            </label>
            <textarea
              id="role-description"
              className="ps-admin-select"
              rows={2}
              maxLength={500}
              dir="auto"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={locked || saving}
              style={{ resize: 'vertical', fontFamily: 'inherit' }}
            />
          </div>

          <PermissionMatrix registry={view.registry} value={permissions} onChange={setPermissions} disabled={locked || saving} />

          {state.mode === 'edit' && detail && !isAdminRole && (
            <DataScopeSection
              roleId={detail.role_id}
              rules={view.dataScope[detail.role_id] ?? []}
              dimensions={view.dimensions}
              disabled={readOnlyForUser}
              onChange={onDataScopeChange}
            />
          )}

          {error && <p style={{ fontSize: 13, color: 'var(--ps-color-alert)', margin: 0 }}>{error}</p>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
              {locked ? 'Close' : 'Cancel'}
            </Button>
            {!locked && (
              <Button type="submit" disabled={saving || name.trim().length < 2}>
                {saving ? 'Saving...' : state.mode === 'create' ? 'Create role' : 'Save changes'}
              </Button>
            )}
          </div>
        </form>
      )}
    </Modal>
  );
}

function TriCheckbox({
  state,
  onChange,
  disabled,
  label,
}: {
  state: CheckState;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'some';
  }, [state]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={label}
      title={label}
      checked={state === 'all'}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

/** Rows = pages grouped as Dashboards / Admin Panel; columns = actions. A cell exists only where
 * the page has that action. Row and column checkboxes select all; any action implies View. */
function PermissionMatrix({
  registry,
  value,
  onChange,
  disabled,
}: {
  registry: PermissionRegistryEntry[];
  value: RolePermissionSet;
  onChange: (next: RolePermissionSet) => void;
  disabled: boolean;
}) {
  const groups = useMemo(
    () => [
      { key: 'dashboard', title: 'Dashboards', entries: registry.filter((e) => e.group === 'dashboard') },
      { key: 'data_entry', title: 'Data Entry', entries: registry.filter((e) => e.group === 'data_entry') },
      { key: 'admin', title: 'Admin Panel', entries: registry.filter((e) => e.group === 'admin') },
    ],
    [registry],
  );

  return (
    <div>
      <div className="ps-admin-label" style={{ marginBottom: 6 }}>
        Permissions
      </div>
      <div style={{ overflowX: 'auto', border: '1px solid var(--ps-color-border)', borderRadius: 'var(--ps-card-radius-sm, 10px)' }}>
        <table className="ps-perm-matrix">
          <thead>
            <tr>
              <th style={{ textAlign: 'start' }}>Page / module</th>
              <th>All</th>
              {ACTIONS.map((a) => (
                <th key={a}>{ACTION_LABEL[a]}</th>
              ))}
            </tr>
          </thead>
          {groups.map((group) => (
            <tbody key={group.key}>
              <tr className="ps-perm-group">
                <th scope="rowgroup" style={{ textAlign: 'start' }}>
                  {group.title}
                </th>
                <td />
                {ACTIONS.map((a) => {
                  const st = columnState(value, group.entries, a);
                  return (
                    <td key={a}>
                      {st && (
                        <TriCheckbox
                          state={st}
                          disabled={disabled}
                          label={`${ACTION_LABEL[a]}: all ${group.title}`}
                          onChange={(checked) => onChange(toggleColumn(value, group.entries, a, checked))}
                        />
                      )}
                    </td>
                  );
                })}
              </tr>
              {group.entries.map((entry) => (
                <tr key={entry.key} className="ps-datatable-row">
                  <th scope="row" style={{ textAlign: 'start', fontWeight: 500 }}>
                    {entry.label}
                  </th>
                  <td>
                    <TriCheckbox
                      state={rowState(value, entry)}
                      disabled={disabled}
                      label={`All actions: ${entry.label}`}
                      onChange={(checked) => onChange(toggleRow(value, entry, checked))}
                    />
                  </td>
                  {ACTIONS.map((a) => (
                    <td key={a}>
                      {entry.actions.includes(a) ? (
                        <input
                          type="checkbox"
                          aria-label={`${ACTION_LABEL[a]}: ${entry.label}`}
                          checked={hasAction(value, entry.key, a)}
                          disabled={disabled}
                          onChange={(e) => onChange(toggleCell(value, entry, a, e.target.checked))}
                        />
                      ) : (
                        <span aria-hidden style={{ color: 'var(--ps-color-border)' }}>
                          —
                        </span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
      <p style={{ fontSize: 11.5, color: 'var(--ps-color-muted-text)', margin: '6px 0 0' }}>
        Any action includes View. Clearing View clears the row. &quot;—&quot; means the action doesn&apos;t apply to that page.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row-level data scope (per role)
// ---------------------------------------------------------------------------

type RuleDraft = { operator: DataScopeOperator; values: string[] };

/**
 * The role's data-scope rules (2026-10-15): one row per dimension -- [Dimension] [is / is not] [values] -- each
 * saved on its own (PUT /admin/roles/:id/data-scope/:dimension, validated by the server), plus a row to add a rule
 * on a dimension that has none. "is" = is any of (only these values); "is not" = is none of (everything except
 * these, values added later included). Rules on different dimensions combine with AND; the live summary under the
 * rows says it in words.
 */
function DataScopeSection({
  roleId,
  rules,
  dimensions,
  disabled,
  onChange,
}: {
  roleId: number;
  rules: DataScopeRule[];
  dimensions: RolesAdminView['dimensions'];
  disabled: boolean;
  onChange: (dataScope: Record<number, DataScopeRule[]>) => void;
}) {
  const { token } = useAuth();
  const saved = useMemo(() => new Map(rules.map((r) => [r.dimension, { operator: r.operator, values: r.values.map((v) => v.value) }])), [rules]);
  const [drafts, setDrafts] = useState<Record<string, RuleDraft>>({});
  const [newDimension, setNewDimension] = useState('');
  const [newRule, setNewRule] = useState<RuleDraft>({ operator: 'in', values: [] });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [triedEmpty, setTriedEmpty] = useState<Record<string, boolean>>({});
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  // value labels: the saved rules' (from the server), then every list a picker loaded (for values just picked)
  const [loadedLabels, setLoadedLabels] = useState<Record<string, string>>({});
  const savedLabels = useMemo(() => {
    const out: Record<string, Record<string, string>> = {};
    for (const r of rules) out[r.dimension] = Object.fromEntries(r.values.map((v) => [v.value, v.label]));
    return out;
  }, [rules]);
  const rememberLabels = useCallback((dimension: string, options: DataScopeValue[]) => {
    setLoadedLabels((prev) => {
      const next = { ...prev };
      for (const o of options) next[`${dimension}:${o.value}`] = o.label;
      return next;
    });
  }, []);

  // a fresh rule list from the server replaces every unsaved edit of a rule it saved
  useEffect(() => setDrafts({}), [rules]);

  const dimLabel = (key: string) => dimensions.find((d) => d.key === key)?.label ?? key;
  const valueLabel = (dimension: string, value: string) => loadedLabels[`${dimension}:${value}`] ?? savedLabels[dimension]?.[value] ?? value;
  const current = (dimension: string): RuleDraft => drafts[dimension] ?? saved.get(dimension) ?? { operator: 'in', values: [] };
  const isDirty = (dimension: string) => {
    const d = drafts[dimension];
    const s = saved.get(dimension);
    return !!d && !!s && (d.operator !== s.operator || d.values.length !== s.values.length || d.values.some((v) => !s.values.includes(v)));
  };
  const usedDimension = newDimension !== '' && saved.has(newDimension);
  // the rule being added counts in the live summary as soon as it has a value (marked unsaved)
  const draftingNew = newDimension !== '' && !usedDimension && newRule.values.length > 0;
  const anyDirty = draftingNew || rules.some((r) => isDirty(r.dimension));

  async function run(key: string, action: () => Promise<{ dataScope: Record<number, DataScopeRule[]> }>, after?: () => void) {
    setBusy(key);
    setError(null);
    try {
      onChange((await action()).dataScope);
      after?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update data scope.');
    } finally {
      setBusy(null);
    }
  }

  function save(dimension: string, draft: RuleDraft, after?: () => void) {
    if (draft.values.length === 0) {
      setTriedEmpty((t) => ({ ...t, [dimension]: true }));
      return;
    }
    if (token) void run(dimension, () => adminApi.saveRoleDataScope(token, roleId, dimension, draft.operator, draft.values), after);
  }

  function pickNewDimension(key: string) {
    setNewDimension(key);
    setNewRule({ operator: 'in', values: [] });
    setTriedEmpty((t) => ({ ...t, __new: false }));
    // a dimension that already has a rule: point at that rule instead of creating a second, conflicting one
    if (key && saved.has(key)) rowRefs.current[key]?.querySelector<HTMLButtonElement>('button')?.focus();
  }

  const summary = scopeSummary([
    ...rules.map((r) => {
      const d = current(r.dimension);
      return { dimensionLabel: dimLabel(r.dimension), operator: d.operator, valueLabels: d.values.map((v) => valueLabel(r.dimension, v)) };
    }),
    ...(draftingNew
      ? [{ dimensionLabel: dimLabel(newDimension), operator: newRule.operator, valueLabels: newRule.values.map((v) => valueLabel(newDimension, v)) }]
      : []),
  ]);

  return (
    <div style={{ paddingTop: 16, borderTop: '1px solid var(--ps-color-border)' }}>
      <div className="ps-admin-label">Data scope rules</div>
      <p style={{ fontSize: 12, color: 'var(--ps-color-muted-text)', margin: '0 0 10px' }}>
        Restricts every page&apos;s data, exports included, for users whose primary role this is. &quot;is&quot; = only the selected values;
        &quot;is not&quot; = everything except them (values added later are included automatically). Rules on different dimensions all apply
        (AND). No rules means all data. Each rule is saved on its own.
      </p>
      {rules.length === 0 ? (
        <p style={{ fontSize: 12.5, color: 'var(--ps-color-muted-text)', margin: '0 0 10px', fontStyle: 'italic' }}>No data scope restrictions.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
          {rules.map((rule) => {
            const d = current(rule.dimension);
            const dirty = isDirty(rule.dimension);
            const empty = d.values.length === 0;
            return (
              <div
                key={rule.dimension}
                ref={(el) => {
                  rowRefs.current[rule.dimension] = el;
                }}
                style={{
                  ...ruleRow,
                  borderColor: usedDimension && newDimension === rule.dimension ? 'var(--ps-color-accent)' : 'var(--ps-color-border)',
                }}
              >
                <div style={{ fontWeight: 600, fontSize: 13.5, minWidth: 130, paddingTop: 24 }}>{dimLabel(rule.dimension)}</div>
                <OperatorToggle
                  value={d.operator}
                  disabled={disabled}
                  onChange={(operator) => setDrafts((x) => ({ ...x, [rule.dimension]: { ...d, operator } }))}
                />
                <div style={{ flex: '1 1 240px', minWidth: 0 }}>
                  <ScopeValueField
                    dimension={rule.dimension}
                    label={`${dimLabel(rule.dimension)} values`}
                    savedLabels={savedLabels[rule.dimension]}
                    onLoaded={rememberLabels}
                    value={d.values}
                    onChange={(values) => setDrafts((x) => ({ ...x, [rule.dimension]: { ...d, values } }))}
                    disabled={disabled}
                    invalid={empty && (dirty || !!triedEmpty[rule.dimension])}
                  />
                  {empty ? <p style={fieldError}>Pick at least one value, or remove the rule.</p> : null}
                </div>
                {!disabled && (
                  <div style={{ display: 'flex', gap: 6, paddingTop: 20 }}>
                    <Button type="button" variant="primary" disabled={!dirty || empty || busy !== null} onClick={() => save(rule.dimension, d)}>
                      {busy === rule.dimension ? 'Saving...' : 'Save'}
                    </Button>
                    {dirty ? (
                      <Button type="button" variant="ghost" disabled={busy !== null} onClick={() => setDrafts(({ [rule.dimension]: _, ...rest }) => rest)}>
                        Undo
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={busy !== null}
                      aria-label={`Remove the ${dimLabel(rule.dimension)} rule`}
                      onClick={() => token && run(rule.dimension, () => adminApi.removeRoleDataScope(token, roleId, rule.dimension))}
                    >
                      <Trash2 size={15} aria-hidden />
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {!disabled && (
        <div style={{ ...ruleRow, borderStyle: 'dashed' }}>
          <div style={{ minWidth: 170 }}>
            <Select
              label="Dimension"
              options={dimensions.map((x) => ({ value: x.key, label: saved.has(x.key) ? `${x.label} (has a rule)` : x.label }))}
              value={newDimension ? [newDimension] : []}
              onChange={(v) => pickNewDimension(v[0] ?? '')}
              placeholder="Choose a dimension"
            />
          </div>
          <OperatorToggle value={newRule.operator} disabled={!newDimension || usedDimension} onChange={(operator) => setNewRule((r) => ({ ...r, operator }))} />
          <div style={{ flex: '1 1 240px', minWidth: 0 }}>
            <ScopeValueField
              dimension={newDimension}
              label="Values"
              onLoaded={rememberLabels}
              value={newRule.values}
              onChange={(values) => setNewRule((r) => ({ ...r, values }))}
              disabled={!newDimension || usedDimension}
              invalid={!!triedEmpty.__new && newRule.values.length === 0}
            />
            {usedDimension ? (
              <p style={fieldError} role="alert">
                {dimLabel(newDimension)} already has a rule (highlighted above): edit that one -- a dimension can have only one rule.
              </p>
            ) : null}
          </div>
          <div style={{ paddingTop: 20 }}>
            <Button
              type="button"
              variant="secondary"
              disabled={!newDimension || usedDimension || newRule.values.length === 0 || busy !== null}
              onClick={() =>
                save(newDimension, newRule, () => {
                  setNewDimension('');
                  setNewRule({ operator: 'in', values: [] });
                })
              }
            >
              <Plus size={15} aria-hidden /> {busy === newDimension ? 'Adding...' : 'Add rule'}
            </Button>
          </div>
        </div>
      )}

      <p role="status" aria-live="polite" style={summaryLine}>
        {summary}
        {anyDirty ? <span style={{ color: 'var(--ps-color-watch)', fontWeight: 600 }}> (unsaved changes)</span> : null}
      </p>
      {error && <p style={{ fontSize: 12, color: 'var(--ps-color-alert)', margin: '8px 0 0' }}>{error}</p>}
    </div>
  );
}

/** The value picker of one rule row, with its dimension's options from useDimensionValues (loaded when the row mounts
 * and whenever the dimension changes; loading / error / retry passed through). Reports each loaded list up, so the
 * summary can name values that were just picked. */
function ScopeValueField({
  dimension,
  onLoaded,
  ...picker
}: Omit<React.ComponentProps<typeof ScopeValuePicker>, 'options' | 'loading' | 'error' | 'onRetry'> & {
  dimension: string;
  onLoaded: (dimension: string, options: DataScopeValue[]) => void;
}) {
  const { options, loading, error, retry } = useDimensionValues(dimension);
  useEffect(() => {
    if (dimension && options.length > 0) onLoaded(dimension, options);
  }, [dimension, options, onLoaded]);
  return <ScopeValuePicker {...picker} options={options} loading={loading} error={error} onRetry={retry} />;
}

/** "is" / "is not" as a two-button toggle (is any of / is none of). */
function OperatorToggle({ value, onChange, disabled }: { value: DataScopeOperator; onChange: (v: DataScopeOperator) => void; disabled?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <span style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--ps-color-muted-text)', marginBottom: 4 }}>Operator</span>
      <div role="group" aria-label="Operator" style={{ display: 'inline-flex', gap: 4, height: 38, alignItems: 'center' }}>
        {(['in', 'not_in'] as const).map((op) => (
          <Button
            key={op}
            type="button"
            variant={value === op ? 'primary' : 'secondary'}
            aria-pressed={value === op}
            title={OPERATOR_HINT[op]}
            disabled={disabled}
            onClick={() => onChange(op)}
            style={{ padding: '6px 12px', fontSize: 13 }}
          >
            {OPERATOR_LABEL[op]}
          </Button>
        ))}
      </div>
    </div>
  );
}

const ruleRow: React.CSSProperties = {
  display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: '8px 12px', padding: '10px 12px', borderRadius: 10,
  border: '1px solid var(--ps-color-border)',
};
const fieldError: React.CSSProperties = { fontSize: 12, color: 'var(--ps-color-alert)', margin: '4px 0 0' };
const summaryLine: React.CSSProperties = {
  margin: '12px 0 0', padding: '8px 12px', borderRadius: 8, background: 'var(--ps-color-muted-bg)', fontSize: 13, color: 'var(--ps-color-text)',
};

// ---------------------------------------------------------------------------
// Delete (with replacement role when users are assigned)
// ---------------------------------------------------------------------------

function DeleteRoleDialog({
  role,
  roles,
  onClose,
  onDeleted,
}: {
  role: RoleSummary;
  roles: RoleSummary[];
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { token } = useAuth();
  const [replacement, setReplacement] = useState<number | ''>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsReplacement = role.user_count > 0;
  const candidates = roles.filter((r) => r.role_id !== role.role_id);

  async function handleDelete() {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await adminApi.deleteRole(token, role.role_id, needsReplacement ? Number(replacement) : null);
      onDeleted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete role.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Delete role "${role.role_label}"?`} onClose={onClose}>
      <p style={{ fontSize: 13.5, margin: '0 0 12px', lineHeight: 1.5 }}>
        {needsReplacement
          ? `${role.user_count} user(s) have this role. Choose the role they should get instead; the change is logged.`
          : 'No users have this role. Its permissions and data-scope rules are removed. This cannot be undone.'}
      </p>
      {needsReplacement && (
        <div style={{ marginBottom: 12 }}>
          <label className="ps-admin-label" htmlFor="replacement-role">
            Replacement role
          </label>
          <select
            id="replacement-role"
            className="ps-admin-select"
            value={replacement}
            onChange={(e) => setReplacement(e.target.value ? Number(e.target.value) : '')}
            disabled={busy}
          >
            <option value="">Select a role</option>
            {candidates.map((r) => (
              <option key={r.role_id} value={r.role_id}>
                {r.role_label}
              </option>
            ))}
          </select>
        </div>
      )}
      {error && <p style={{ fontSize: 13, color: 'var(--ps-color-alert)', margin: '0 0 12px' }}>{error}</p>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="danger" onClick={handleDelete} disabled={busy || (needsReplacement && replacement === '')}>
          {busy ? 'Deleting...' : needsReplacement ? 'Reassign and delete' : 'Delete role'}
        </Button>
      </div>
    </Modal>
  );
}
