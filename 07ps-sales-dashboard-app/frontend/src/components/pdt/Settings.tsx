'use client';
import React, { useEffect, useState } from 'react';
import { Button, Card, ErrorState, LoadingSkeleton } from '@07ps/ui';
import { useAuth } from '../../lib/AuthProvider';
import { apiFieldError, usePdp } from '../../lib/pdp/hooks';
import Link from 'next/link';
import { BASE } from '../../lib/pdp/api';
import { TRACKER, trackerCall, type DropdownValue, type Settings } from '../../lib/pdt/api';
import s from './Pdt.module.css';

const LISTS: [DropdownValue['list_key'], string, string][] = [
  ['family', 'Product families', 'Add, rename, describe, deactivate. A family used by a product cannot be deleted. The Excel import also adds the families of its Lists sheet.'],
  ['stage', 'Stages', 'Fixed list (the rules and the Excel file use it): rename, recolour, reorder.'],
  ['health', 'Health', 'Fixed list: rename and recolour.'],
  ['priority', 'Priorities', 'Fixed list: rename and recolour.'],
  ['project_type', 'Project types', 'Fixed list: rename.'],
];

const SETTING_FIELDS: [keyof Settings, string, string][] = [
  ['staleDays', 'Stale after (days without an update)', '"No update" marker on the pipeline and the follow-up board.'],
  ['upcomingWindowDays', 'Upcoming launches window (days)', 'The "Launches in next N days" card and the launch roadmap (same window).'],
  ['followupDueSoonDays', 'Blockers due soon (days)', 'Follow-up board: items due within this many days.'],
  ['launchSoonDays', 'Launch soon (days)', 'Follow-up board: launches within this many days…'],
  ['launchSoonMinReadiness', '…below readiness (%)', '…with readiness below this.'],
];

/**
 * Admin → Product Development Settings (Admin role only, backend requireAdminRole): the tracker's drop-down lists and
 * follow-up settings, in the Kaizen Dropdowns style.
 */
export function TrackerSettings() {
  const { token } = useAuth();
  const [revision, setRevision] = useState(0);
  const data = usePdp<{ rows: DropdownValue[]; settings: Settings }>(`${TRACKER}/admin/dropdowns`, revision);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const reload = () => setRevision((n) => n + 1);

  const act = async (fn: () => Promise<unknown>, done = 'Saved.') => {
    setError(null);
    setSaved(null);
    try {
      await fn();
      setSaved(done);
      reload();
      return true;
    } catch (err) {
      setError(apiFieldError(err).message);
      return false;
    }
  };

  if (data.error) return <ErrorState message={data.error} onRetry={data.retry} />;
  if (!data.data) return <LoadingSkeleton variant="table" />;
  const rows = data.data.rows;

  return (
    <div className={s.stack} data-testid="pdt-settings">
      <div>
        <h2 className={s.cardTitle}>Product Development Plan settings</h2>
        <p className={s.cardSub}>The lists and follow-up rules behind the Product Development Plan dashboard and its data entry.</p>
        <p className={s.cardSub}>
          R&amp;D gate screens (TIKA gate module, Admin only):{' '}
          <Link className={s.linkBtn} href={`${BASE}/gates`}>Open the gate overview →</Link>
        </p>
      </div>
      {error && <div className={s.error} role="alert">{error}</div>}
      {saved && <div className={s.badge} role="status" style={{ padding: '8px 10px', fontSize: 13, width: 'fit-content' }}>{saved}</div>}

      <SettingsCard settings={data.data.settings} onSave={(v) => act(() => trackerCall(`/admin/settings`, token, 'PUT', v), 'Settings saved.')} />

      {LISTS.map(([key, title, help]) => (
        <Card key={key}>
          <h3 className={s.cardTitle} style={{ fontSize: 15 }}>{title}</h3>
          <p className={s.cardSub} style={{ marginBottom: 12 }}>{help}</p>
          <div className={s.tableWrap} style={{ margin: 0 }}>
            <table className={s.table}>
              <thead><tr><th>Label</th>{key === 'family' && <th>Description</th>}<th>Colour</th><th>Order</th>{key === 'family' && <th>Active</th>}<th>Used by</th><th /></tr></thead>
              <tbody>
                {rows.filter((r) => r.list_key === key).sort((a, b) => a.sort_order - b.sort_order).map((r) => (
                  <ValueRow key={r.value_id} row={r} onSave={(patch) => act(() => trackerCall(`/admin/dropdowns/${r.value_id}`, token, 'PATCH', patch))} onDelete={key === 'family' ? () => act(() => trackerCall(`/admin/dropdowns/${r.value_id}`, token, 'DELETE'), 'Deleted.') : undefined} />
                ))}
              </tbody>
            </table>
          </div>
          {key === 'family' && <NewCategory onAdd={(label, color) => act(() => trackerCall('/admin/dropdowns', token, 'POST', { listKey: 'family', label, color }), 'Family added.')} />}
        </Card>
      ))}
    </div>
  );
}

function SettingsCard({ settings, onSave }: { settings: Settings; onSave: (v: Settings) => Promise<boolean> }) {
  const [v, setV] = useState<Record<keyof Settings, string>>(() => Object.fromEntries(Object.entries(settings).map(([k, x]) => [k, String(x)])) as Record<keyof Settings, string>);
  useEffect(() => setV(Object.fromEntries(Object.entries(settings).map(([k, x]) => [k, String(x)])) as Record<keyof Settings, string>), [settings]);
  return (
    <Card>
      <h3 className={s.cardTitle} style={{ fontSize: 15, marginBottom: 12 }}>Follow-up settings</h3>
      <form className={s.form} onSubmit={(e) => { e.preventDefault(); void onSave(Object.fromEntries(Object.entries(v).map(([k, x]) => [k, Number(x)])) as unknown as Settings); }}>
        {SETTING_FIELDS.map(([k, label, hint]) => (
          <div key={k}>
            <label className={s.fieldLabel} htmlFor={`pdt-set-${k}`}>{label}</label>
            <input id={`pdt-set-${k}`} className={s.input} type="number" min={0} value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} />
            <div className={s.muted}>{hint}</div>
          </div>
        ))}
        <div className={s.formActions}><Button type="submit">Save settings</Button></div>
      </form>
    </Card>
  );
}

function ValueRow({ row, onSave, onDelete }: { row: DropdownValue; onSave: (p: Record<string, unknown>) => Promise<boolean>; onDelete?: () => Promise<boolean> }) {
  const [label, setLabel] = useState(row.label);
  const [color, setColor] = useState(row.color);
  const [order, setOrder] = useState(String(row.sort_order));
  const [description, setDescription] = useState(row.description ?? '');
  const isFamily = row.list_key === 'family';
  const dirty = label !== row.label || color.toLowerCase() !== row.color.toLowerCase() || order !== String(row.sort_order) || (isFamily && description !== (row.description ?? ''));
  return (
    <tr>
      <td><input className={s.input} aria-label="Label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={100} /></td>
      {isFamily && (
        <td style={{ minWidth: 260 }}><input className={s.input} aria-label="Description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} /></td>
      )}
      <td><input className={s.swatchInput} aria-label="Colour" type="color" value={color} onChange={(e) => setColor(e.target.value)} /></td>
      <td style={{ width: 90 }}><input className={s.input} aria-label="Order" type="number" value={order} onChange={(e) => setOrder(e.target.value)} /></td>
      {!row.code && (
        <td><input type="checkbox" aria-label="Active" checked={Boolean(row.is_active)} onChange={(e) => void onSave({ isActive: e.target.checked })} /></td>
      )}
      <td className={s.muted}>{row.usage_count ?? 0} product{row.usage_count === 1 ? '' : 's'}</td>
      <td style={{ whiteSpace: 'nowrap', textAlign: 'end' }}>
        <Button variant="secondary" disabled={!dirty} onClick={() => void onSave({ label, color, sortOrder: Number(order), ...(isFamily ? { description } : {}) })}>Save</Button>{' '}
        {onDelete && <Button variant="ghost" disabled={(row.usage_count ?? 0) > 0} onClick={() => void onDelete()}>Delete</Button>}
      </td>
    </tr>
  );
}

function NewCategory({ onAdd }: { onAdd: (label: string, color: string) => Promise<boolean> }) {
  const [label, setLabel] = useState('');
  const [color, setColor] = useState('#8a94a6');
  return (
    <form style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }} onSubmit={async (e) => { e.preventDefault(); if (await onAdd(label, color)) setLabel(''); }}>
      <input className={s.input} style={{ maxWidth: 260 }} aria-label="New family" placeholder="New family" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={100} />
      <input className={s.swatchInput} aria-label="Colour" type="color" value={color} onChange={(e) => setColor(e.target.value)} />
      <Button type="submit" disabled={!label.trim()}>Add</Button>
    </form>
  );
}
