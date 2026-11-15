'use client';
import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button, DataGrid, Select, TextInput, type DataGridColumn } from '@07ps/ui';
import { OdooLink } from '../OdooLink';
import { useAuth } from '../../lib/AuthProvider';
import { BASE, ENTRY, pdp, type Row } from '../../lib/pdp/api';
import { usePdp } from '../../lib/pdp/hooks';
import { copy as t, enumLabel, STATE_COLOR, STATUS_COLOR } from '../../lib/pdp/text';
import type { SectionProps } from './PdpPage';
import { ActionButton, Chip, Details, Empty, ExportBar, FormToggle, Loaded, PdpForm, Section, fields, fmtDate } from './ui';
import s from './PdpVisuals.module.css';

const STATUSES = ['in_market', 'under_development', 'planned', 'discontinued'];
const PRODUCT_FIELDS = 'name! status:select plannedLaunchDate:date actualLaunchDate:date launchDateFlexible:checkbox description:textarea comment';

export function Tree({ options, revision, refresh }: SectionProps) {
  const { canCreate, canEdit, canDelete, token } = useAuth();
  const params = useSearchParams();
  const router = useRouter();
  const tree = usePdp<Row>('/tree', revision);
  const [search, setSearch] = useState('');
  const [statuses, setStatuses] = useState<string[]>([]);
  const [families, setFamilies] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const selected = params?.get('product') ? Number(params.get('product')) : null;
  const open = (id: number | null) => router.replace(id ? `${BASE}/tree?product=${id}` : `${BASE}/tree`, { scroll: false });

  const familyOptions = (options.families as Row[]).map((f) => ({ value: String(f.family_id), label: f.name }));
  const toggle = (key: string) => setCollapsed((c) => {
    const n = new Set(c);
    if (n.has(key)) n.delete(key);
    else n.add(key);
    return n;
  });

  return (
    <>
      <div className={s.toolbar}>
        <div style={{ width: 240 }}>
          <TextInput label={t.search} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Product, family or description" />
        </div>
        <div style={{ width: 220 }}>
          <Select label="Status" options={STATUSES.map((v) => ({ value: v, label: enumLabel(v) }))} value={statuses} onChange={setStatuses} multiSelect placeholder="All statuses" />
        </div>
        <div style={{ width: 240 }}>
          <Select label="Family" options={familyOptions} value={families} onChange={setFamilies} multiSelect searchable placeholder="All families" />
        </div>
      </div>
      <Loaded state={tree}>
        {(d) => {
          const brands = filterTree(d.tree as Row[], search, statuses, families);
          const total = (d.tree as Row[]).reduce((n, b) => n + b.families.reduce((m: number, f: Row) => m + f.subfamilies.reduce((k: number, sf: Row) => k + sf.products.length, 0), 0), 0);
          const allKeys = brands.flatMap((b) => [`b${b.brand_id}`, ...b.families.flatMap((f: Row) => [`f${f.family_id}`, ...f.subfamilies.map((sf: Row) => `s${sf.subfamily_id}`)])]);
          return (
            <Section
              title={`${t.tabs.tree} (${total} ${t.tree.products})`}
              help={{ definition: t.tree.help }}
              actions={
                <>
                  <Button variant="secondary" style={{ padding: '6px 12px', fontSize: 12.5 }} onClick={() => setCollapsed(new Set())}>{t.tree.expandAll}</Button>
                  <Button variant="secondary" style={{ padding: '6px 12px', fontSize: 12.5 }} onClick={() => setCollapsed(new Set(allKeys))}>{t.tree.collapseAll}</Button>
                  <ExportBar area="tree" fileName="xtreme-product-tree.xlsx" />
                </>
              }
              testId="pdp-tree"
            >
              <div className={s.legend} style={{ marginBottom: 10 }}>
                <span><i className={s.swatch} style={{ background: '#2f6fd1' }} />Brand</span>
                <span><i className={s.swatch} style={{ background: '#2f9e5b' }} />Family</span>
                <span><i className={s.swatch} style={{ background: '#e07b24' }} />Subfamily</span>
                <span><i className={s.swatch} style={{ background: '#8a4fc7' }} />Product</span>
                {STATUSES.map((st) => <Chip key={st} color={STATUS_COLOR[st]}>{enumLabel(st)}</Chip>)}
              </div>
              {total === 0 ? (
                <Empty message={t.empty.tree} />
              ) : brands.length === 0 ? (
                <Empty message={t.empty.treeFiltered} />
              ) : (
                <ul className={s.tree} role="tree" aria-label={t.tabs.tree}>
                  {brands.map((b) => (
                    <li key={b.brand_id} role="treeitem" aria-selected={false} aria-expanded={!collapsed.has(`b${b.brand_id}`)}>
                      <div className={s.node}>
                        <button type="button" className={`${s.toggle} ${s.level1}`} onClick={() => toggle(`b${b.brand_id}`)}>
                          {collapsed.has(`b${b.brand_id}`) ? '▸' : '▾'} {b.name}
                        </button>
                      </div>
                      {!collapsed.has(`b${b.brand_id}`) && (
                        <ul role="group">
                          {b.families.map((f: Row) => (
                            <li key={f.family_id} role="treeitem" aria-selected={false} aria-expanded={!collapsed.has(`f${f.family_id}`)}>
                              <div className={s.node}>
                                <button type="button" className={`${s.toggle} ${s.level2}`} onClick={() => toggle(`f${f.family_id}`)}>
                                  {collapsed.has(`f${f.family_id}`) ? '▸' : '▾'} {f.name}
                                  <span className={s.count}>{f.subfamilies.reduce((n: number, sf: Row) => n + sf.products.length, 0)}</span>
                                </button>
                                {f.description && <p className={s.desc} dir="auto">{f.description}</p>}
                              </div>
                              {!collapsed.has(`f${f.family_id}`) && (
                                <ul role="group">
                                  {f.subfamilies.map((sf: Row) => (
                                    <li key={sf.subfamily_id} role="treeitem" aria-selected={false} aria-expanded={!collapsed.has(`s${sf.subfamily_id}`)}>
                                      <div className={s.node}>
                                        <button type="button" className={`${s.toggle} ${s.level3}`} onClick={() => toggle(`s${sf.subfamily_id}`)}>
                                          {collapsed.has(`s${sf.subfamily_id}`) ? '▸' : '▾'} {sf.name}
                                          <span className={s.count}>{sf.products.length}</span>
                                        </button>
                                      </div>
                                      {!collapsed.has(`s${sf.subfamily_id}`) && (
                                        <div className={s.products} role="group">
                                          {sf.products.map((p: Row) => <ProductChip key={p.product_id} p={p} onOpen={() => open(p.product_id)} />)}
                                        </div>
                                      )}
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          );
        }}
      </Loaded>

      {(canCreate(ENTRY) || canEdit(ENTRY) || canDelete(ENTRY)) && <ManageTree options={options} refresh={refresh} token={token} />}
      {selected && <ProductPanel id={selected} options={options} revision={revision} refresh={refresh} close={() => open(null)} />}
    </>
  );
}

function filterTree(tree: Row[], search: string, statuses: string[], families: string[]): Row[] {
  const q = search.trim().toLowerCase();
  const matches = (f: Row, sf: Row, p: Row) =>
    (statuses.length === 0 || statuses.includes(p.status)) &&
    (!q || [p.name, p.description, sf.name, f.name].some((v) => String(v ?? '').toLowerCase().includes(q)));
  return tree
    .map((b) => ({
      ...b,
      families: b.families
        .filter((f: Row) => families.length === 0 || families.includes(String(f.family_id)))
        .map((f: Row) => ({ ...f, subfamilies: f.subfamilies.map((sf: Row) => ({ ...sf, products: sf.products.filter((p: Row) => matches(f, sf, p)) })).filter((sf: Row) => sf.products.length > 0 || (!q && statuses.length === 0)) }))
        .filter((f: Row) => f.subfamilies.length > 0),
    }))
    .filter((b) => b.families.length > 0);
}

function ProductChip({ p, onOpen }: { p: Row; onOpen: () => void }) {
  const late = p.status !== 'in_market' && p.status !== 'discontinued' && p.planned_launch_date && p.planned_launch_date < new Date().toISOString().slice(0, 10);
  return (
    <span className={s.productWrap}>
      <button type="button" className={s.product} onClick={onOpen} aria-label={`${p.name}, ${enumLabel(p.status)}`}>
        <span dir="auto">{p.name}</span>
        <Chip color={STATUS_COLOR[p.status]}>{enumLabel(p.status)}</Chip>
        {late && <Chip color="var(--ps-color-alert)">{t.late}</Chip>}
      </button>
      <span className={s.hoverCard} role="tooltip">
        <strong dir="auto">{p.name}</strong>
        <span style={{ display: 'block', margin: '4px 0' }} dir="auto">{p.description || '—'}</span>
        <span style={{ display: 'block' }}>Status: {enumLabel(p.status)}</span>
        <span style={{ display: 'block' }}>
          Launch: {fmtDate(p.status === 'in_market' ? p.actual_launch_date ?? p.planned_launch_date : p.planned_launch_date)}
          {p.launch_date_flexible ? ` (${t.flexible})` : ''}
        </span>
        {p.odoo_name && <span style={{ display: 'block' }} dir="auto">Odoo: {p.odoo_name}</span>}
      </span>
    </span>
  );
}

/** Add / edit / move / retire families, subfamilies and products (data entry). */
function ManageTree({ options, refresh, token }: { options: Row; refresh: () => void; token: string | null }) {
  const { canCreate, canEdit, canDelete } = useAuth();
  const [familyId, setFamilyId] = useState('');
  const [subfamilyId, setSubfamilyId] = useState('');
  const family = (options.families as Row[]).find((f) => String(f.family_id) === familyId);
  const subfamily = (options.families as Row[]).flatMap((f) => f.subfamilies.map((sf: Row) => ({ ...sf, family_id: f.family_id }))).find((sf) => String(sf.subfamily_id) === subfamilyId);
  return (
    <Section title="Manage the tree" help={{ definition: 'Add families, subfamilies and products; rename or retire an empty family or subfamily. To edit, move or retire a product, open it in the tree.' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {canCreate(ENTRY) && (
          <>
            <FormToggle label={t.tree.addFamily}>
              {(close) => <PdpForm spec={fields('brandId!:select name! description:textarea')} options={options} onCancel={close} onSaved={() => { close(); refresh(); }} onSubmit={(v) => pdp('/families', token, 'POST', v)} />}
            </FormToggle>
            <FormToggle label={t.tree.addSubfamily}>
              {(close) => <PdpForm spec={fields('familyId!:select name!')} options={options} onCancel={close} onSaved={() => { close(); refresh(); }} onSubmit={(v) => pdp('/subfamilies', token, 'POST', v)} />}
            </FormToggle>
            <FormToggle label={t.tree.addProduct}>
              {(close) => <PdpForm spec={fields(`subfamilyId!:select ${PRODUCT_FIELDS}`)} options={options} onCancel={close} onSaved={() => { close(); refresh(); }} onSubmit={(v) => pdp('/products', token, 'POST', v)} />}
            </FormToggle>
          </>
        )}
        {(canEdit(ENTRY) || canDelete(ENTRY)) && (
          <FormToggle label="Edit or retire a family / subfamily">
            {(close) => (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div className="ps-kaizen-form">
                  <label className="ps-kaizen-field">
                    <span>Family</span>
                    <select className="ps-kaizen-input" value={familyId} onChange={(e) => setFamilyId(e.target.value)}>
                      <option value="">{t.choose}</option>
                      {(options.families as Row[]).map((f) => <option key={f.family_id} value={f.family_id}>{f.name}</option>)}
                    </select>
                  </label>
                  <label className="ps-kaizen-field">
                    <span>Subfamily</span>
                    <select className="ps-kaizen-input" value={subfamilyId} onChange={(e) => setSubfamilyId(e.target.value)}>
                      <option value="">{t.choose}</option>
                      {(options.families as Row[]).flatMap((f) => f.subfamilies.map((sf: Row) => <option key={sf.subfamily_id} value={sf.subfamily_id}>{f.name} › {sf.name}</option>))}
                    </select>
                  </label>
                </div>
                {family && canEdit(ENTRY) && (
                  <PdpForm key={`f${family.family_id}`} spec={fields('name! description:textarea')} initial={{ name: family.name, description: family.description }} options={options}
                    submitLabel="Save family" onSaved={refresh} onSubmit={(v) => pdp(`/families/${family.family_id}`, token, 'PATCH', v)}
                    extraActions={canDelete(ENTRY) ? <ActionButton variant="danger" confirmText={`Retire the family "${family.name}"?`} onClick={async () => { await pdp(`/families/${family.family_id}`, token, 'DELETE'); setFamilyId(''); refresh(); }}>{t.tree.retireFamily}</ActionButton> : undefined} />
                )}
                {subfamily && canEdit(ENTRY) && (
                  <PdpForm key={`s${subfamily.subfamily_id}`} spec={fields('familyId!:select name!')} initial={{ familyId: subfamily.family_id, name: subfamily.name }} options={options}
                    submitLabel="Save subfamily" onSaved={refresh} onSubmit={(v) => pdp(`/subfamilies/${subfamily.subfamily_id}`, token, 'PATCH', v)}
                    extraActions={canDelete(ENTRY) ? <ActionButton variant="danger" confirmText={`Retire the subfamily "${subfamily.name}"?`} onClick={async () => { await pdp(`/subfamilies/${subfamily.subfamily_id}`, token, 'DELETE'); setSubfamilyId(''); refresh(); }}>{t.tree.retireSubfamily}</ActionButton> : undefined} />
                )}
                <div><Button variant="secondary" onClick={close}>{t.close}</Button></div>
              </div>
            )}
          </FormToggle>
        )}
      </div>
    </Section>
  );
}

/** Side panel: the product, its projects, launch, feedback and history; edit / move / link to Odoo with entry rights. */
function ProductPanel({ id, options, revision, refresh, close }: { id: number; options: Row; revision: number; refresh: () => void; close: () => void }) {
  const { token, canEdit } = useAuth();
  const panel = usePdp<Row>(`/products/${id}`, revision);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);
  const projectCols: DataGridColumn<Row>[] = [
    { key: 'code', header: 'Code', render: (r) => <Link href={`${BASE}/projects/${r.code}`}>{r.code}</Link>, rawValue: (r) => r.code },
    { key: 'title', header: 'Title' },
    { key: 'current_gate', header: 'Gate' },
    { key: 'state', header: 'State', render: (r) => <Chip color={STATE_COLOR[r.state]}>{enumLabel(r.state)}</Chip>, rawValue: (r) => r.state },
  ];
  const feedbackCols: DataGridColumn<Row>[] = [
    { key: 'feedback_date', header: 'Date', render: (r) => fmtDate(r.feedback_date), rawValue: (r) => r.feedback_date },
    { key: 'customer', header: 'Customer', render: (r) => <OdooLink href={r.customer_odoo_url}>{r.customer ?? '—'}</OdooLink>, rawValue: (r) => r.customer ?? '' },
    { key: 'rating', header: 'Rating', align: 'right' },
    { key: 'followup_status', header: 'Follow-up', render: (r) => enumLabel(r.followup_status), rawValue: (r) => r.followup_status },
  ];
  const historyCols: DataGridColumn<Row>[] = [
    { key: 'changed_at', header: 'When', render: (r) => fmtDate(r.changed_at), rawValue: (r) => r.changed_at },
    { key: 'field', header: 'Change', render: (r) => `${r.field}: ${r.from_value ?? '—'} → ${r.to_value ?? '—'}`, rawValue: (r) => r.field },
    { key: 'reason', header: 'Reason', render: (r) => <span dir="auto">{r.reason ?? '—'}</span> },
    { key: 'changed_by_name', header: 'By' },
  ];
  return (
    <>
      <div className={s.backdrop} onClick={close} aria-hidden />
      <aside className={s.panel} role="dialog" aria-modal="true" aria-label="Product details" data-testid="pdp-product-panel">
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button variant="secondary" onClick={close}>{t.close}</Button>
        </div>
        <Loaded state={panel}>
          {(d) => (
            <>
              <h2 style={{ margin: 0, fontSize: 20 }} dir="auto">
                <OdooLink href={d.product.odoo_url}>{d.product.name}</OdooLink>
              </h2>
              <Details
                items={[
                  ['Status', <Chip key="s" color={STATUS_COLOR[d.product.status]}>{enumLabel(d.product.status)}</Chip>],
                  ['Planned launch', `${fmtDate(d.product.planned_launch_date)}${d.product.launch_date_flexible ? ` (${t.flexible})` : ''}`],
                  ['Actual launch', fmtDate(d.product.actual_launch_date)],
                  ['Odoo product', d.product.odoo_name ? <OdooLink key="o" href={d.product.odoo_url}>{d.product.odoo_name}</OdooLink> : 'Not linked'],
                  ['Description', d.product.description],
                  ['Comment', d.product.comment],
                  ['Launch record', d.launch ? `${enumLabel(d.launch.status)} · ${fmtDate(d.launch.launch_date)}` : 'None'],
                  ['Average rating', d.avgRating ?? '—'],
                ]}
              />
              <Section title="Projects">
                {d.projects.length ? <DataGrid columns={projectCols} rows={d.projects} getRowId={(r) => r.code} enableFiltering={false} maxBodyHeight={240} /> : <Empty message={t.empty.productProjects} />}
              </Section>
              <Section title="Customer feedback">
                {d.feedback.length ? <DataGrid columns={feedbackCols} rows={d.feedback} getRowId={(r) => String(r.feedback_id)} enableFiltering={false} maxBodyHeight={240} /> : <Empty message={t.empty.productFeedback} />}
              </Section>
              {canEdit(ENTRY) && (
                <Section title="Edit, move or retire">
                  <PdpForm
                    key={`p${d.product.product_id}-${revision}`}
                    spec={fields(`subfamilyId!:select ${PRODUCT_FIELDS} reason`, { reason: { hint: t.tree.reasonHint, full: true } })}
                    initial={{
                      subfamilyId: d.product.subfamily_id, name: d.product.name, status: d.product.status, plannedLaunchDate: d.product.planned_launch_date,
                      actualLaunchDate: d.product.actual_launch_date, launchDateFlexible: d.product.launch_date_flexible, description: d.product.description, comment: d.product.comment,
                    }}
                    options={options}
                    onSaved={refresh}
                    onSubmit={(v) => pdp(`/products/${id}`, token, 'PATCH', v)}
                  />
                </Section>
              )}
              {canEdit(ENTRY) && <OdooLinkForm productId={id} current={d.product} refresh={refresh} />}
              <Section title="History">
                {d.history.length ? <DataGrid columns={historyCols} rows={d.history.map((h: Row, i: number) => ({ ...h, i }))} getRowId={(r) => String(r.i)} enableFiltering={false} maxBodyHeight={260} /> : <Empty message={t.empty.history} />}
              </Section>
            </>
          )}
        </Loaded>
      </aside>
    </>
  );
}

/** Pick the matching TIKA Odoo product (search by name or code); the change is recorded with a reason. */
function OdooLinkForm({ productId, current, refresh }: { productId: number; current: Row; refresh: () => void }) {
  const { token } = useAuth();
  const [q, setQ] = useState('');
  const results = usePdp<Row>(q.trim().length >= 2 ? `/odoo-products?q=${encodeURIComponent(q.trim())}` : null);
  const [picked, setPicked] = useState<Row | null>(null);
  const options = useMemo(() => ((results.data?.products ?? []) as Row[]).map((p) => ({ value: p.ProductKey, label: `${p.OdooProductName}${p.default_code ? ` [${p.default_code}]` : ''}` })), [results.data]);
  return (
    <Section title={t.tree.linkOdoo} help={{ definition: 'Links this Xtreme product to its Odoo product (TIKA or shared products only), so its post-launch sales appear under Launches. Nothing is linked automatically.' }}>
      <div className="ps-kaizen-form" style={{ marginBottom: 12 }}>
        <TextInput label="Search Odoo products" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type 2+ letters of the name or code" />
        <label className="ps-kaizen-field">
          <span>Odoo product</span>
          <select className="ps-kaizen-input" value={picked?.value ?? ''} onChange={(e) => setPicked(options.find((o) => String(o.value) === e.target.value) ?? null)}>
            <option value="">{results.loading ? t.loading : options.length ? t.choose : q.trim().length >= 2 ? 'No TIKA product matches' : t.choose}</option>
            {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          {results.error && <em role="alert" style={{ fontStyle: 'normal', fontSize: 12, color: 'var(--ps-color-alert)' }}>{results.error}</em>}
        </label>
      </div>
      <PdpForm
        spec={fields('reason!', { reason: { full: true, hint: current.odoo_name ? `Currently linked to ${current.odoo_name}.` : 'Not linked yet.' } })}
        submitLabel="Save link"
        onSaved={refresh}
        onSubmit={(v) => {
          if (!picked) throw Object.assign(new Error('Pick an Odoo product first.'));
          return pdp(`/products/${productId}`, token, 'PATCH', { dimProductKey: picked.value, reason: v.reason });
        }}
      />
    </Section>
  );
}
