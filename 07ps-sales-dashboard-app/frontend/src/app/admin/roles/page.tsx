'use client';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Lock, Pencil, Plus, Trash2, X } from 'lucide-react';
import { Button, Card, EmptyState, ErrorState, LoadingSkeleton, Select, TextInput } from '@07ps/ui';
import { AdminLayout } from '../../../components/AdminLayout';
import { PermissionGuard } from '../../../components/AuthGuard';
import { useAuth } from '../../../lib/AuthProvider';
import { useFilterOptions } from '../../../lib/hooks';
import {
  adminApi,
  ApiError,
  DataScopeRule,
  DimOption,
  PermissionAction,
  PermissionRegistryEntry,
  RoleDetail,
  RolePermissionSet,
  RolesAdminView,
  RoleSummary,
} from '../../../lib/api';
import { CheckState, columnState, hasAction, rowState, toggleCell, toggleColumn, toggleRow } from '../../../lib/rolePermissions';

const ACTION_LABEL: Record<PermissionAction, string> = {
  view: 'View',
  create: 'Create',
  edit: 'Edit',
  delete: 'Delete',
  export: 'Export',
};
const ACTIONS: PermissionAction[] = ['view', 'create', 'edit', 'delete', 'export'];

/** Which useFilterOptions() field + DimOption key/label fields back each data-scope dimension's
 * value picker -- same value-list endpoints FilterBar already uses. */
const DIMENSION_OPTION_FIELDS: Record<string, { key: string; label: string }> = {
  companyKeys: { key: 'company_key', label: 'company_name' },
  segmentKeys: { key: 'segment_key', label: 'segment_name' },
  channelKeys: { key: 'channel_key', label: 'channel_name' },
  salesTeamKeys: { key: 'sales_team_key', label: 'sales_team_name' },
  salespersonKeys: { key: 'salesperson_key', label: 'salesperson_name' },
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function AdminRolesPage() {
  return (
    <PermissionGuard pageKey="admin_roles">
      <AdminLayout title="Roles & Permissions">
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
  const { token, error: authError, retryAuth } = useAuth();
  const filterOptions = useFilterOptions(token, authError, retryAuth);
  const dimensionOptions: Record<string, DimOption[]> = {
    companyKeys: filterOptions.businessUnits.data ?? [],
    segmentKeys: filterOptions.customerGroups.data ?? [],
    channelKeys: filterOptions.distributionChannels.data ?? [],
    salesTeamKeys: filterOptions.branches.data ?? [],
    salespersonKeys: filterOptions.salespersons.data ?? [],
  };
  const [dimension, setDimension] = useState(dimensions[0]?.key ?? '');
  const [value, setValue] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fields = DIMENSION_OPTION_FIELDS[dimension];
  const valueOptions = (dimensionOptions[dimension] ?? []).map((opt) => ({
    value: String(opt[fields?.key ?? '']),
    label: String(opt[fields?.label ?? '']),
  }));

  async function run(action: () => Promise<{ dataScope: Record<number, DataScopeRule[]> }>) {
    setBusy(true);
    setError(null);
    try {
      onChange((await action()).dataScope);
      setValue([]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update data scope.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ paddingTop: 16, borderTop: '1px solid var(--ps-color-border)' }}>
      <div className="ps-admin-label">Data scope rules</div>
      <p style={{ fontSize: 12, color: 'var(--ps-color-muted-text)', margin: '0 0 10px' }}>
        Restricts every page&apos;s data to the values below for users whose primary role this is. No rules means all data.
        Saved immediately.
      </p>
      {rules.length === 0 ? (
        <p style={{ fontSize: 12.5, color: 'var(--ps-color-muted-text)', margin: '0 0 10px', fontStyle: 'italic' }}>
          No data scope restrictions.
        </p>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
          {rules.map((rule) => {
            const dimLabel = dimensions.find((d) => d.key === rule.dimension)?.label ?? rule.dimension;
            return (
              <span key={rule.scopeId} className="ps-chip">
                <span dir="auto">
                  {dimLabel}: {rule.label}
                </span>
                {!disabled && (
                  <button
                    type="button"
                    onClick={() => token && run(() => adminApi.removeRoleDataScope(token, roleId, rule.scopeId))}
                    disabled={busy}
                    aria-label={`Remove ${dimLabel}: ${rule.label}`}
                  >
                    ×
                  </button>
                )}
              </span>
            );
          })}
        </div>
      )}
      {!disabled && (
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 180 }}>
            <Select
              label="Dimension"
              options={dimensions.map((d) => ({ value: d.key, label: d.label }))}
              value={dimension ? [dimension] : []}
              onChange={(v) => {
                setDimension(v[0] ?? '');
                setValue([]);
              }}
              placeholder="Choose a dimension"
            />
          </div>
          <div style={{ minWidth: 200 }}>
            <Select label="Value" options={valueOptions} value={value} onChange={setValue} searchable disabled={!dimension} placeholder="Choose a value" />
          </div>
          <Button
            type="button"
            variant="secondary"
            disabled={busy || value.length === 0}
            onClick={() => token && run(() => adminApi.addRoleDataScope(token, roleId, dimension, value[0]))}
          >
            Add rule
          </Button>
        </div>
      )}
      {error && <p style={{ fontSize: 12, color: 'var(--ps-color-alert)', margin: '8px 0 0' }}>{error}</p>}
    </div>
  );
}

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
