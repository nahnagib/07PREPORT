'use client';
import React, { useState } from 'react';
import { ChartPanel, ComboChart, DataGrid, KpiTile, Select, type DataGridColumn } from '@07ps/ui';
import { OdooLink } from '../OdooLink';
import { useAuth } from '../../lib/AuthProvider';
import { ENTRY, pdp, type Row } from '../../lib/pdp/api';
import { usePdp } from '../../lib/pdp/hooks';
import { copy as t, enumLabel } from '../../lib/pdp/text';
import type { SectionProps } from './PdpPage';
import { Chip, Empty, ExportBar, FormToggle, Loaded, PdpForm, Section, fields, fmtDate } from './ui';
import s from './PdpVisuals.module.css';

const STATUSES = ['open', 'in_progress', 'resolved', 'closed'];
const STATUS_COLOR: Record<string, string> = { open: 'var(--ps-color-alert)', in_progress: 'var(--ps-color-gold)', resolved: 'var(--ps-color-success)', closed: 'var(--ps-color-muted-text)' };

export function Feedback({ options, revision, refresh }: SectionProps) {
  const { token, canCreate, canEdit } = useAuth();
  const [status, setStatus] = useState<string[]>([]);
  const feedback = usePdp<Row>(`/feedback${status[0] ? `?status=${status[0]}` : ''}`, revision);
  const [selected, setSelected] = useState<Row | null>(null);

  const cols: DataGridColumn<Row>[] = [
    { key: 'feedback_date', header: 'Date', render: (r) => fmtDate(r.feedback_date), rawValue: (r) => r.feedback_date },
    { key: 'product_name', header: 'Product', render: (r) => <OdooLink href={r.product_odoo_url}>{r.product_name}</OdooLink>, rawValue: (r) => r.product_name },
    { key: 'customer_name', header: 'Customer', render: (r) => <OdooLink href={r.customer_odoo_url}>{r.odoo_customer ?? r.customer_name}</OdooLink>, rawValue: (r) => r.odoo_customer ?? r.customer_name ?? '' },
    { key: 'channel', header: 'Channel' },
    { key: 'rating', header: 'Rating', align: 'right', render: (r) => `${r.rating} / 5` , rawValue: (r) => r.rating },
    { key: 'category', header: 'Category' },
    { key: 'comment', header: 'Comment', width: 260, render: (r) => <span dir="auto">{r.comment ?? '—'}</span>, rawValue: (r) => r.comment ?? '' },
    { key: 'owner_name', header: 'Follow-up owner', rawValue: (r) => r.owner_name ?? '' },
    { key: 'followup_status', header: 'Follow-up', render: (r) => <Chip color={STATUS_COLOR[r.followup_status]}>{enumLabel(r.followup_status)}</Chip>, rawValue: (r) => enumLabel(r.followup_status), filterOptions: STATUSES.map((v) => ({ value: enumLabel(v), label: enumLabel(v) })) },
    { key: 'due_date', header: 'Due', render: (r) => fmtDate(r.due_date), rawValue: (r) => r.due_date ?? '' },
  ];

  return (
    <>
      <div className={s.toolbar}>
        <div style={{ width: 220 }}>
          <Select label="Follow-up status" options={STATUSES.map((v) => ({ value: v, label: enumLabel(v) }))} value={status} onChange={(v) => setStatus(v.slice(-1))} placeholder="All" />
        </div>
      </div>
      <Loaded state={feedback}>
        {(d) => {
          const rows = d.feedback as Row[];
          const avgAll = rows.length ? Math.round((rows.reduce((n, r) => n + Number(r.rating), 0) / rows.length) * 10) / 10 : null;
          return (
            <>
              <div className={s.kpis}>
                <KpiTile label="Feedback records" value={String(rows.length)} status="neutral" />
                <KpiTile label="Average rating" value={avgAll === null ? '—' : `${avgAll} / 5`} status={avgAll === null ? 'neutral' : avgAll >= 4 ? 'success' : avgAll >= 3 ? 'watch' : 'alert'} />
                <KpiTile label="Open follow-ups" value={String(d.openFollowups)} status={d.openFollowups > 0 ? 'watch' : 'success'} />
              </div>
              <Section
                title={t.feedback.title}
                actions={
                  <>
                    <ExportBar area="feedback" fileName="customer-feedback.xlsx" />
                    {canCreate(ENTRY) && (
                      <FormToggle label={t.feedback.add}>
                        {(close) => (
                          <PdpForm
                            spec={fields('productId!:select feedbackDate!:date customerName! channelId!:select rating!:number categoryId!:select comment:textarea followupOwnerUserId:select dueDate:date', { rating: { min: 1, max: 5, hint: '1 (poor) to 5 (excellent)' } })}
                            options={options}
                            onCancel={close}
                            onSaved={() => { close(); refresh(); }}
                            onSubmit={(v) => pdp('/feedback', token, 'POST', v)}
                          />
                        )}
                      </FormToggle>
                    )}
                  </>
                }
                testId="pdp-feedback"
              >
                {rows.length ? <DataGrid columns={cols} rows={rows} getRowId={(r) => String(r.feedback_id)} fileName="customer-feedback" onRowClick={(r) => setSelected(r)} /> : <Empty message={status.length ? 'No feedback with this follow-up status.' : t.empty.feedback} />}
              </Section>
              {selected && canEdit(ENTRY) && <FollowUp row={selected} options={options} revision={revision} refresh={refresh} />}
              {(d.averages as Row[]).length > 0 && (
                <ChartPanel title={t.feedback.averages} help={{ definition: 'Average customer rating (1–5) per product over the listed feedback.' }}>
                  <ComboChart
                    showTitle={false}
                    points={(d.averages as Row[]).map((a) => ({ label: a.product, avgRating: a.avgRating, count: a.count }))}
                    bars={[{ key: 'avgRating', name: 'Average rating', color: 'var(--ps-color-accent)' }]}
                    lines={[{ key: 'count', name: 'Records', color: 'var(--ps-color-gold)', yAxisId: 'right' }]}
                    height={280}
                  />
                </ChartPanel>
              )}
            </>
          );
        }}
      </Loaded>
    </>
  );
}

function FollowUp({ row, options, revision, refresh }: { row: Row; options: Row; revision: number; refresh: () => void }) {
  const { token } = useAuth();
  const history = usePdp<Row>(`/feedback/${row.feedback_id}/history`, revision);
  const cols: DataGridColumn<Row>[] = [
    { key: 'changed_at', header: 'When', render: (r) => (r.changed_at ? new Date(r.changed_at).toLocaleString('en-GB') : '—'), rawValue: (r) => r.changed_at },
    { key: 'field', header: 'Change' },
    { key: 'from_value', header: 'From', rawValue: (r) => r.from_value ?? '' },
    { key: 'to_value', header: 'To', render: (r) => <span dir="auto">{r.to_value ?? '—'}</span>, rawValue: (r) => r.to_value ?? '' },
    { key: 'comment', header: 'Note', render: (r) => <span dir="auto">{r.comment ?? '—'}</span>, rawValue: (r) => r.comment ?? '' },
    { key: 'changed_by_name', header: 'By' },
  ];
  return (
    <Section title={`${t.feedback.followup}: ${row.product_name} · ${row.odoo_customer ?? row.customer_name}`}>
      <PdpForm
        key={row.feedback_id}
        spec={fields('followupStatus!:select followupOwnerUserId:select dueDate:date resolution:textarea note:textarea', { resolution: { hint: 'Required to resolve or close.' }, note: { label: 'Note for the history' } })}
        initial={{ followupStatus: row.followup_status, followupOwnerUserId: row.followup_owner_user_id, dueDate: row.due_date, resolution: row.resolution }}
        options={options}
        onSaved={refresh}
        onSubmit={(v) => pdp(`/feedback/${row.feedback_id}`, token, 'PATCH', v)}
      />
      <div style={{ marginTop: 14 }}>
        <Loaded state={history}>{(h) => ((h.history as Row[]).length ? <DataGrid columns={cols} rows={(h.history as Row[]).map((x, i) => ({ ...x, i }))} getRowId={(r) => String(r.i)} enableFiltering={false} maxBodyHeight={220} /> : <Empty message={t.empty.history} />)}</Loaded>
      </div>
    </Section>
  );
}
