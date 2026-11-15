'use client';
import React, { useState } from 'react';
import Link from 'next/link';
import { ChartPanel, ComboChart, DataGrid, type DataGridColumn } from '@07ps/ui';
import { OdooLink } from '../OdooLink';
import { useAuth } from '../../lib/AuthProvider';
import { formatNumber } from '../../lib/format';
import { BASE, ENTRY, pdp, type Row } from '../../lib/pdp/api';
import { usePdp } from '../../lib/pdp/hooks';
import { copy as t, enumLabel } from '../../lib/pdp/text';
import type { SectionProps } from './PdpPage';
import { Chip, Empty, FormToggle, Loaded, PdpForm, Section, fields, fmtDate } from './ui';

const tick = (ok: boolean | null, label: string) =>
  ok === null ? <Chip color="var(--ps-color-muted-text)">{label}: n/a</Chip> : <Chip color={ok ? 'var(--ps-color-success)' : 'var(--ps-color-alert)'}>{label}: {ok ? 'done' : 'open'}</Chip>;

/** The CEO's "monitoring tools": launches with their readiness, and post-launch TIKA sales from the warehouse. */
export function Launches({ options, revision, refresh }: SectionProps) {
  const { token, canCreate, canEdit } = useAuth();
  const launches = usePdp<Row>('/launches', revision);
  const [selected, setSelected] = useState<Row | null>(null);

  const cols: DataGridColumn<Row>[] = [
    { key: 'product_name', header: 'Product', width: 220, render: (r) => <OdooLink href={r.product_odoo_url}>{r.product_name}</OdooLink>, rawValue: (r) => r.product_name },
    { key: 'family', header: 'Family' },
    { key: 'project_code', header: 'Project', render: (r) => (r.project_code ? <Link href={`${BASE}/projects/${r.project_code}`}>{r.project_code}</Link> : '—'), rawValue: (r) => r.project_code ?? '' },
    { key: 'launch_date', header: 'Launch date', render: (r) => fmtDate(r.launch_date), rawValue: (r) => r.launch_date ?? '' },
    { key: 'status', header: 'Status', render: (r) => <Chip color={r.status === 'launched' ? 'var(--ps-color-success)' : r.status === 'ready' ? 'var(--ps-color-accent)' : 'var(--ps-color-muted-text)'}>{enumLabel(r.status)}</Chip>, rawValue: (r) => r.status },
    {
      key: 'readiness',
      header: 'Readiness',
      width: 320,
      render: (r) => (
        <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {tick(r.readiness.documentation, 'Docs')}
          {tick(r.readiness.training, 'Training')}
          {tick(r.readiness.communication, 'Comms')}
          {tick(r.readiness.exco, 'EXCO')}
        </span>
      ),
      rawValue: (r) => Object.values(r.readiness).filter(Boolean).length,
    },
    { key: 'avg_rating', header: 'Avg rating', align: 'right', rawValue: (r) => r.avg_rating ?? '' },
  ];
  const upcomingCols: DataGridColumn<Row>[] = [
    { key: 'code', header: 'Project', render: (r) => <Link href={`${BASE}/projects/${r.code}`}>{r.code}</Link>, rawValue: (r) => r.code },
    { key: 'product_name', header: 'Product' },
    { key: 'current_gate', header: 'Gate' },
    { key: 'target_launch_date', header: 'Target launch', render: (r) => fmtDate(r.target_launch_date), rawValue: (r) => r.target_launch_date ?? '' },
    { key: 'documentation', header: 'Documentation package', render: (r) => tick(r.documentation, 'Docs'), rawValue: (r) => (r.documentation ? 'done' : 'open') },
  ];

  return (
    <Loaded state={launches}>
      {(d) => (
        <>
          <Section
            title={t.launches.title}
            help={{ definition: 'Products launched or launching, with the readiness checklist: documentation package, training, communication and EXCO approval. Click a row for its sales.' }}
            actions={canCreate(ENTRY) ? (
              <FormToggle label={t.launches.addLaunch}>
                {(close) => <PdpForm spec={fields('productId!:select launchDate:date notes:textarea')} options={options} onCancel={close} onSaved={() => { close(); refresh(); }} onSubmit={(v) => pdp('/launches', token, 'POST', v)} />}
              </FormToggle>
            ) : undefined}
            testId="pdp-launches"
          >
            {(d.launches as Row[]).length ? (
              <DataGrid columns={cols} rows={d.launches} getRowId={(r) => String(r.launch_id)} fileName="pdp-launches" onRowClick={(r) => setSelected(r)} />
            ) : (
              <Empty message={t.empty.launches} />
            )}
          </Section>

          {selected && canEdit(ENTRY) && (
            <Section title={`${t.edit}: ${selected.product_name}`}>
              <PdpForm
                key={selected.launch_id}
                spec={fields('launchDate:date trainingDone:checkbox communicationDone:checkbox notes:textarea')}
                initial={{ launchDate: selected.launch_date, trainingDone: selected.training_done, communicationDone: selected.communication_done, notes: selected.notes }}
                onSaved={refresh}
                onSubmit={(v) => pdp(`/launches/${selected.launch_id}`, token, 'PATCH', v)}
              />
            </Section>
          )}

          <Sales product={selected} revision={revision} />

          <Section title={t.launches.upcoming}>
            {(d.upcoming as Row[]).length ? <DataGrid columns={upcomingCols} rows={d.upcoming} getRowId={(r) => r.code} enableFiltering={false} /> : <Empty message={t.empty.upcoming} />}
          </Section>
        </>
      )}
    </Loaded>
  );
}

function Sales({ product, revision }: { product: Row | null; revision: number }) {
  const sales = usePdp<Row>(product ? `/products/${product.product_id}/sales` : null, revision);
  const title = product ? `${t.launches.sales}: ${product.product_name}` : t.launches.sales;
  if (!product) {
    return (
      <Section title={title} help={{ definition: t.launches.salesHelp }}>
        <Empty message={t.empty.salesPick} />
      </Section>
    );
  }
  return (
    <Loaded state={sales} skeleton="chart">
      {(d) => {
        if (!d.linked) return <Section title={title} help={{ definition: t.launches.salesHelp }}><Empty message={t.empty.salesNoLink} /></Section>;
        const months = d.months as Row[];
        const any = months.some((m) => m.qty || m.value);
        const cols: DataGridColumn<Row>[] = [
          { key: 'month', header: 'Month' },
          { key: 'qty', header: 'Quantity', align: 'right', render: (r) => formatNumber(r.qty), rawValue: (r) => r.qty },
          { key: 'uom', header: 'Unit', rawValue: (r) => r.uom ?? '' },
          { key: 'value', header: 'Revenue (LYD)', align: 'right', render: (r) => formatNumber(r.value), rawValue: (r) => r.value },
          { key: 'intercompanyValue', header: 'of which intercompany', align: 'right', render: (r) => formatNumber(r.intercompanyValue), rawValue: (r) => r.intercompanyValue },
        ];
        return (
          <ChartPanel title={title} help={{ definition: t.launches.salesHelp }} tableColumns={cols as never} tableRows={months as never} getRowId={(r: Row) => r.month}>
            <p style={{ margin: '0 0 8px', fontSize: 13 }}>
              Odoo: <OdooLink href={d.odooUrl}>{d.odooName}</OdooLink> · from {fmtDate(d.start)}
            </p>
            {!any ? (
              <Empty message={t.empty.sales} />
            ) : (
              <>
                <ComboChart
                  showTitle={false}
                  points={months.map((m) => ({ label: m.month, qty: m.qty, value: m.value }))}
                  bars={[{ key: 'qty', name: 'Quantity', color: 'var(--ps-color-accent)' }]}
                  lines={[{ key: 'value', name: 'Revenue (LYD)', color: 'var(--ps-color-gold)', yAxisId: 'right' }]}
                  leftAxisFormatter={(v) => formatNumber(v)}
                  rightAxisFormatter={(v) => formatNumber(v)}
                  height={300}
                />
                <DataGrid columns={cols} rows={months} getRowId={(r) => r.month} enableFiltering={false} fileName="pdp-post-launch-sales" />
              </>
            )}
          </ChartPanel>
        );
      }}
    </Loaded>
  );
}
