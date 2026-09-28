'use client';
import React, { useCallback, useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Plus } from 'lucide-react';
import { Button, Card, ErrorState } from '@07ps/ui';
import { AdminLayout } from '../../../components/AdminLayout';
import { AdminOnlyGuard } from '../../../components/AuthGuard';
import { useAuth } from '../../../lib/AuthProvider';
import { useLanguage } from '../../../lib/i18n/LanguageProvider';
import type { MessageKey } from '../../../lib/i18n/messages';
import { ApiError } from '../../../lib/api';
import { errorCode, kaizenApi, type KaizenDropdownValue, type KaizenListKey } from '../../../lib/kaizen/api';

const LISTS: KaizenListKey[] = ['department', 'card_type', 'card_priority'];

/**
 * Kaizen Board dropdown lists (Department / Card Type / Card Priority): EN + AR label, sort order,
 * chart colour, active flag. Admin role only (backend: requireAdminRole). A value any card uses can
 * be deactivated but not deleted.
 */
export default function KaizenDropdownsPage() {
  const { t } = useLanguage();
  return (
    <AdminOnlyGuard>
      <AdminLayout title={t('kaizen.dropdownsTitle')}>
        <DropdownsBody />
      </AdminLayout>
    </AdminOnlyGuard>
  );
}

function DropdownsBody() {
  const { token } = useAuth();
  const { t } = useLanguage();
  const [rows, setRows] = useState<KaizenDropdownValue[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!token) return;
    kaizenApi
      .adminListDropdowns(token)
      .then((r) => setRows(r.rows))
      .catch((err) => setError(err instanceof ApiError ? err.message : t('kaizen.loadError')));
  }, [token, t]);

  useEffect(load, [load]);

  const fail = (err: unknown) => {
    const code = errorCode(err);
    setActionError(code && t(`err.${code}` as MessageKey) !== `err.${code}` ? t(`err.${code}` as MessageKey) : err instanceof ApiError ? err.message : t('err.generic'));
  };
  const act = async (fn: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await fn();
      load();
      return true;
    } catch (err) {
      fail(err);
      return false;
    }
  };

  if (error) return <ErrorState message={error} />;
  if (!rows) return <p style={{ color: 'var(--ps-color-muted-text)' }}>{t('shell.loading')}</p>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1000 }}>
      <p style={{ margin: 0, fontSize: 13, color: 'var(--ps-color-muted-text)' }}>{t('kaizen.dd.note')}</p>
      {actionError && <p role="alert" style={{ margin: 0, color: 'var(--ps-color-alert)' }}>{actionError}</p>}
      {LISTS.map((list) => (
        <ListSection key={list} list={list} rows={rows.filter((r) => r.list_key === list)} act={act} />
      ))}
    </div>
  );
}

function ListSection({ list, rows, act }: { list: KaizenListKey; rows: KaizenDropdownValue[]; act: (fn: () => Promise<unknown>) => Promise<boolean> }) {
  const { token } = useAuth();
  const { t, formatNumber } = useLanguage();
  const [draft, setDraft] = useState({ labelEn: '', labelAr: '', color: '#4d88c4' });

  const move = (index: number, delta: number) => {
    if (!token) return;
    const ids = rows.map((r) => r.value_id);
    const [id] = ids.splice(index, 1);
    ids.splice(index + delta, 0, id);
    act(() => kaizenApi.adminReorderDropdowns(token, list, ids));
  };

  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <strong style={{ fontSize: 15 }}>{t(`kaizen.dd.list.${list}` as MessageKey)}</strong>
      <div className="ps-kaizen-table-wrap">
        <table className="ps-kaizen-table">
          <thead>
            <tr>
              <th>{t('kaizen.dd.order')}</th>
              <th>{t('kaizen.dd.color')}</th>
              <th>{t('kaizen.dd.labelEn')}</th>
              <th>{t('kaizen.dd.labelAr')}</th>
              <th>{t('kaizen.dd.usage')}</th>
              <th>{t('kaizen.f.status')}</th>
              <th>{t('kaizen.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <ValueRow key={`${r.value_id}-${r.label_en}-${r.label_ar}-${r.color}`} row={r} index={i} last={i === rows.length - 1} move={move} act={act} usage={formatNumber(r.usage_count ?? 0)} />
            ))}
          </tbody>
        </table>
      </div>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!token) return;
          const ok = await act(() => kaizenApi.adminCreateDropdown(token, { listKey: list, ...draft }));
          if (ok) setDraft({ labelEn: '', labelAr: '', color: '#4d88c4' });
        }}
        className="ps-kaizen-filters"
      >
        <label className="ps-kaizen-field">
          <span>{t('kaizen.dd.color')}</span>
          <input type="color" className="ps-kaizen-input" style={{ width: 56, padding: 2 }} value={draft.color} onChange={(e) => setDraft({ ...draft, color: e.target.value })} />
        </label>
        <label className="ps-kaizen-field" style={{ flex: '1 1 180px' }}>
          <span>{t('kaizen.dd.labelEn')}</span>
          <input className="ps-kaizen-input" dir="ltr" value={draft.labelEn} maxLength={100} onChange={(e) => setDraft({ ...draft, labelEn: e.target.value })} />
        </label>
        <label className="ps-kaizen-field" style={{ flex: '1 1 180px' }}>
          <span>{t('kaizen.dd.labelAr')}</span>
          <input className="ps-kaizen-input" dir="rtl" value={draft.labelAr} maxLength={100} onChange={(e) => setDraft({ ...draft, labelAr: e.target.value })} />
        </label>
        <Button type="submit" disabled={!draft.labelEn.trim() || !draft.labelAr.trim()}>
          <Plus size={15} />
          {t('kaizen.dd.add')}
        </Button>
      </form>
    </Card>
  );
}

function ValueRow({
  row,
  index,
  last,
  move,
  act,
  usage,
}: {
  row: KaizenDropdownValue;
  index: number;
  last: boolean;
  move: (index: number, delta: number) => void;
  act: (fn: () => Promise<unknown>) => Promise<boolean>;
  usage: string;
}) {
  const { token } = useAuth();
  const { t } = useLanguage();
  const [edit, setEdit] = useState({ labelEn: row.label_en, labelAr: row.label_ar, color: row.color });
  const dirty = edit.labelEn !== row.label_en || edit.labelAr !== row.label_ar || edit.color !== row.color;
  const small: React.CSSProperties = { padding: '3px 8px', fontSize: 12 };

  return (
    <tr style={row.is_active ? undefined : { opacity: 0.6 }}>
      <td>
        <div style={{ display: 'flex', gap: 4 }}>
          <Button variant="ghost" style={small} disabled={index === 0} aria-label={t('kaizen.dd.moveUp')} onClick={() => move(index, -1)}><ArrowUp size={13} /></Button>
          <Button variant="ghost" style={small} disabled={last} aria-label={t('kaizen.dd.moveDown')} onClick={() => move(index, 1)}><ArrowDown size={13} /></Button>
        </div>
      </td>
      <td><input type="color" aria-label={t('kaizen.dd.color')} value={edit.color} onChange={(e) => setEdit({ ...edit, color: e.target.value })} style={{ width: 40, height: 28, border: 'none', background: 'none', cursor: 'pointer' }} /></td>
      <td><input className="ps-kaizen-input" dir="ltr" aria-label={t('kaizen.dd.labelEn')} value={edit.labelEn} maxLength={100} onChange={(e) => setEdit({ ...edit, labelEn: e.target.value })} style={{ minWidth: 160 }} /></td>
      <td><input className="ps-kaizen-input" dir="rtl" aria-label={t('kaizen.dd.labelAr')} value={edit.labelAr} maxLength={100} onChange={(e) => setEdit({ ...edit, labelAr: e.target.value })} style={{ minWidth: 160 }} /></td>
      <td>{usage}</td>
      <td>{row.is_active ? t('kaizen.dd.active') : t('kaizen.dd.inactive')}</td>
      <td>
        <div style={{ display: 'flex', gap: 6 }}>
          <Button style={small} disabled={!dirty} onClick={() => token && act(() => kaizenApi.adminUpdateDropdown(token, row.value_id, edit))}>{t('kaizen.save')}</Button>
          <Button variant="secondary" style={small} onClick={() => token && act(() => kaizenApi.adminUpdateDropdown(token, row.value_id, { isActive: !row.is_active }))}>
            {row.is_active ? t('kaizen.dd.deactivate') : t('kaizen.dd.reactivate')}
          </Button>
          {(row.usage_count ?? 0) === 0 && (
            <Button
              variant="secondary"
              style={{ ...small, color: 'var(--ps-color-alert)' }}
              onClick={() => token && window.confirm(t('kaizen.dd.confirmDelete', { label: row.label_en })) && act(() => kaizenApi.adminDeleteDropdown(token, row.value_id))}
            >
              {t('kaizen.delete')}
            </Button>
          )}
        </div>
      </td>
    </tr>
  );
}
