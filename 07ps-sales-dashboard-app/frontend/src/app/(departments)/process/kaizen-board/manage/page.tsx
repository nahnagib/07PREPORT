'use client';
import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowDown, ArrowUp, Download, Plus, Upload } from 'lucide-react';
import { Button, Card, ErrorState } from '@07ps/ui';
import { PermissionGuard } from '../../../../../components/AuthGuard';
import { KaizenShell, KAIZEN_BASE } from '../../../../../components/kaizen/KaizenShell';
import { KaizenFilterBar } from '../../../../../components/kaizen/KaizenFilterBar';
import { CardDetail, StatusPill, ValueTag } from '../../../../../components/kaizen/KaizenBits';
import { CloseCardDialog } from '../../../../../components/kaizen/CloseCardDialog';
import { KaizenImportPanel } from '../../../../../components/kaizen/KaizenImportPanel';
import { useKaizenOptions } from '../../../../../components/kaizen/useKaizenOptions';
import { useUrlFilters } from '../../../../../components/kaizen/useUrlFilters';
import { useAuth } from '../../../../../lib/AuthProvider';
import { useLanguage } from '../../../../../lib/i18n/LanguageProvider';
import type { MessageKey } from '../../../../../lib/i18n/messages';
import { ApiError } from '../../../../../lib/api';
import { kaizenApi, type KaizenCard } from '../../../../../lib/kaizen/api';

/**
 * Kaizen cards list for data entry (Kaizen Cards permission). Search + filters + sortable columns;
 * Open cards past their Expected Date are highlighted. Add/Edit/Close/Delete/Export follow the
 * user's Create/Edit/Delete/Export actions; the one-time Excel import is Admin only.
 */
export default function KaizenManagePage() {
  return (
    <PermissionGuard pageKey="kaizen_cards">
      <ManageBody />
    </PermissionGuard>
  );
}

type SortKey = 'card_no' | 'card_date' | 'card_name' | 'department' | 'type' | 'priority' | 'responsible_party' | 'status' | 'expected_date' | 'closer_date';
/** Sorts the backend can apply too (the Excel export follows the on-screen order when it can). */
const SERVER_SORTS = new Set<SortKey>(['card_no', 'card_date', 'card_name', 'responsible_party', 'status', 'expected_date', 'closer_date']);

function ManageBody() {
  const { token, canCreate, canEdit, canDelete, canExport, isAdmin } = useAuth();
  const { t, lang, formatNumber } = useLanguage();
  const options = useKaizenOptions();
  const { filters, setFilters, openNo, setOpenNo } = useUrlFilters();
  const [rows, setRows] = useState<KaizenCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'card_no', dir: 'desc' });
  const [closing, setClosing] = useState<KaizenCard | null>(null);
  const [exporting, setExporting] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!token || !filters) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      kaizenApi
        .listCards(token, filters)
        .then((r) => !cancelled && (setRows(r.rows), setError(null)))
        .catch(() => !cancelled && setError(t('kaizen.loadError')));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, filters, reload]);

  const sorted = useMemo(() => {
    if (!rows) return [];
    const val = (c: KaizenCard): string | number => {
      switch (sort.key) {
        case 'department': return options.labelOf(c.department_id);
        case 'type': return options.labelOf(c.card_type_id);
        case 'priority': return options.labelOf(c.priority_id);
        case 'responsible_party': return c.responsible_party ?? '';
        case 'card_no': return c.card_no;
        default: return (c[sort.key] as string | null) ?? '';
      }
    };
    const mult = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      const cmp = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), lang);
      return cmp * mult || b.card_no - a.card_no;
    });
  }, [rows, sort, options, lang]);

  const actions = (
        <>
          {canCreate('kaizen_cards') && (
            <Link href={`${KAIZEN_BASE}/manage/new`} style={{ textDecoration: 'none' }}>
              <Button>
                <Plus size={15} />
                {t('kaizen.newCard')}
              </Button>
            </Link>
          )}
          {canExport('kaizen_cards') && (
            <Button
              variant="secondary"
              disabled={exporting || !filters}
              onClick={async () => {
                if (!token || !filters) return;
                setExporting(true);
                setActionError(null);
                try {
                  await kaizenApi.exportCards(token, filters, SERVER_SORTS.has(sort.key) ? { by: sort.key, dir: sort.dir } : { by: 'card_no', dir: 'desc' }, lang);
                } catch (err) {
                  setActionError(err instanceof ApiError ? err.message : t('err.generic'));
                } finally {
                  setExporting(false);
                }
              }}
            >
              <Download size={15} />
              {exporting ? t('kaizen.exporting') : t('kaizen.export')}
            </Button>
          )}
          {isAdmin && (
            <Button variant="secondary" onClick={() => setShowImport((s) => !s)} aria-expanded={showImport}>
              <Upload size={15} />
              {t('kaizen.import')}
            </Button>
          )}
        </>
  );

  const body = (() => {
    if (error) return <ErrorState message={error} />;
    if (!filters || !rows || options.loading) return <p style={{ color: 'var(--ps-color-muted-text)' }}>{t('shell.loading')}</p>;

    if (openNo !== null) {
      const card = rows.find((r) => r.card_no === openNo);
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 860 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button variant="secondary" onClick={() => setOpenNo(null)}>{t('kaizen.cancel')}</Button>
            {card && canEdit('kaizen_cards') && (
              <Link href={`${KAIZEN_BASE}/manage/${card.card_no}`} style={{ textDecoration: 'none' }}>
                <Button>{t('kaizen.edit')}</Button>
              </Link>
            )}
          </div>
          <Card>{card ? <CardDetail card={card} options={options} /> : <p style={{ margin: 0 }}>{t('kaizen.notFound')}</p>}</Card>
        </div>
      );
    }

    const header = (key: SortKey, labelKey: MessageKey) => (
      <th aria-sort={sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
        <button type="button" onClick={() => setSort((s) => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' }))}>
          {t(labelKey)} {sort.key === key && (sort.dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
        </button>
      </th>
    );
    const small: React.CSSProperties = { padding: '3px 8px', fontSize: 12 };

    return (
      <>
        {showImport && isAdmin && <KaizenImportPanel onImported={() => setReload((n) => n + 1)} />}
        <KaizenFilterBar filters={filters} onChange={setFilters} options={options} full />
        <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, fontSize: 13, color: 'var(--ps-color-muted-text)' }}>
          <span>{t('kaizen.list.count', { n: formatNumber(rows.length) })}</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span className="ps-kaizen-dot" style={{ background: 'var(--ps-color-alert)' }} />
            {t('kaizen.overdue')}: {t('kaizen.overdueHint')}
          </span>
        </div>
        {actionError && <p style={{ color: 'var(--ps-color-alert)', margin: 0 }}>{actionError}</p>}
        {rows.length === 0 ? (
          <Card>
            <p style={{ margin: 0, color: 'var(--ps-color-muted-text)' }}>{t('kaizen.list.empty')}</p>
          </Card>
        ) : (
          <div className="ps-kaizen-table-wrap">
            <table className="ps-kaizen-table">
              <thead>
                <tr>
                  {header('card_no', 'kaizen.f.no')}
                  {header('card_date', 'kaizen.f.date')}
                  {header('card_name', 'kaizen.f.cardName')}
                  {header('department', 'kaizen.f.department')}
                  {header('type', 'kaizen.f.type')}
                  {header('priority', 'kaizen.f.priority')}
                  {header('responsible_party', 'kaizen.f.responsible')}
                  {header('status', 'kaizen.f.status')}
                  {header('expected_date', 'kaizen.f.expectedDate')}
                  {header('closer_date', 'kaizen.f.closerDate')}
                  <th>{t('kaizen.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((c) => (
                  <tr key={c.card_no} className={c.is_overdue ? 'ps-kaizen-overdue' : undefined}>
                    <td style={{ fontWeight: 700 }}>#{c.card_no}</td>
                    <td>{c.card_date}</td>
                    <td className="ps-kaizen-wrap">
                      <button type="button" dir="auto" onClick={() => setOpenNo(c.card_no)} style={{ all: 'unset', cursor: 'pointer', fontWeight: 600, color: 'var(--ps-color-accent)' }}>
                        {c.card_name}
                      </button>
                    </td>
                    <td><ValueTag id={c.department_id} options={options} /></td>
                    <td><ValueTag id={c.card_type_id} options={options} /></td>
                    <td><ValueTag id={c.priority_id} options={options} /></td>
                    <td>{c.responsible_party ?? <span style={{ color: 'var(--ps-color-muted-text)' }}>{t('kaizen.notAssigned')}</span>}</td>
                    <td><StatusPill status={c.status} overdue={c.is_overdue} /></td>
                    <td style={c.is_overdue ? { color: 'var(--ps-color-alert)', fontWeight: 700 } : undefined}>{c.expected_date ?? '—'}</td>
                    <td>{c.closer_date ?? '—'}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <Button variant="secondary" style={small} onClick={() => setOpenNo(c.card_no)}>{t('kaizen.view')}</Button>
                        {canEdit('kaizen_cards') && (
                          <Link href={`${KAIZEN_BASE}/manage/${c.card_no}`} style={{ textDecoration: 'none' }}>
                            <Button variant="secondary" style={small}>{t('kaizen.edit')}</Button>
                          </Link>
                        )}
                        {canEdit('kaizen_cards') && c.status === 'OPEN' && (
                          <Button variant="secondary" style={{ ...small, color: 'var(--ps-color-success)' }} onClick={() => setClosing(c)}>
                            {t('kaizen.close')}
                          </Button>
                        )}
                        {canDelete('kaizen_cards') && (
                          <Button
                            variant="secondary"
                            style={{ ...small, color: 'var(--ps-color-alert)' }}
                            onClick={async () => {
                              if (!token || !window.confirm(t('kaizen.confirmDelete', { no: c.card_no, name: c.card_name }))) return;
                              setActionError(null);
                              try {
                                await kaizenApi.deleteCard(token, c.card_no);
                                setReload((n) => n + 1);
                              } catch (err) {
                                setActionError(err instanceof ApiError ? err.message : t('err.generic'));
                              }
                            }}
                          >
                            {t('kaizen.delete')}
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {closing && (
          <CloseCardDialog
            card={closing}
            onCancel={() => setClosing(null)}
            onClosed={() => {
              setClosing(null);
              setReload((n) => n + 1);
            }}
          />
        )}
      </>
    );
  })();

  return (
    <KaizenShell titleKey="kaizen.manageTitle" actions={actions}>
      {body}
    </KaizenShell>
  );
}
