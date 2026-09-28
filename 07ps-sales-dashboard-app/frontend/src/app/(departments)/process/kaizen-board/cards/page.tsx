'use client';
import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Pencil } from 'lucide-react';
import { Card, ErrorState } from '@07ps/ui';
import { NoAccess } from '../../../../../components/NoAccess';
import { KaizenShell, KAIZEN_BASE } from '../../../../../components/kaizen/KaizenShell';
import { KaizenFilterBar } from '../../../../../components/kaizen/KaizenFilterBar';
import { CardDetail, StatusPill, ValueTag } from '../../../../../components/kaizen/KaizenBits';
import { useKaizenOptions } from '../../../../../components/kaizen/useKaizenOptions';
import { useUrlFilters } from '../../../../../components/kaizen/useUrlFilters';
import { useAuth } from '../../../../../lib/AuthProvider';
import { useLanguage } from '../../../../../lib/i18n/LanguageProvider';
import { kaizenApi, type KaizenCard } from '../../../../../lib/kaizen/api';

/**
 * Kaizen card details -- the page the board's QR code opens (/Dashboard/process/kaizen-board/cards).
 * Mobile-first, read-only: cards newest first with the same filters as the lists; tapping one shows
 * every field. Needs login (AuthGuard sends a scan to /login and back here afterwards) and View on
 * the Kaizen Board (or Kaizen Cards).
 */
export default function KaizenCardDetailsPage() {
  const { canView } = useAuth();
  if (!canView('kaizen_board') && !canView('kaizen_cards')) return <NoAccess />;
  return (
    <KaizenShell titleKey="kaizen.detailsTitle">
      <CardsBody />
    </KaizenShell>
  );
}

function CardsBody() {
  const { token, canEdit } = useAuth();
  const { t, formatNumber } = useLanguage();
  const options = useKaizenOptions();
  const { filters, setFilters, openNo, setOpenNo } = useUrlFilters();
  const [rows, setRows] = useState<KaizenCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token || !filters) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      kaizenApi
        .listCards(token, filters, { by: 'card_date', dir: 'desc' })
        .then((r) => !cancelled && (setRows(r.rows), setError(null)))
        .catch(() => !cancelled && setError(t('kaizen.loadError')));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, filters]);

  if (error) return <ErrorState message={error} />;
  if (!filters || !rows || options.loading) return <p style={{ color: 'var(--ps-color-muted-text)' }}>{t('shell.loading')}</p>;

  const open = openNo !== null ? rows.find((r) => r.card_no === openNo) : undefined;
  if (openNo !== null) {
    return (
      <OpenCard no={openNo} fromList={open} options={options} canEdit={canEdit('kaizen_cards')} onBack={() => setOpenNo(null)} />
    );
  }

  return (
    <>
      <KaizenFilterBar filters={filters} onChange={setFilters} options={options} full />
      <div style={{ fontSize: 13, color: 'var(--ps-color-muted-text)' }}>
        {t('kaizen.list.count', { n: formatNumber(rows.length) })} · {t('kaizen.list.newestFirst')} · {t('kaizen.list.tapHint')}
      </div>
      {rows.length === 0 ? (
        <Card>
          <p style={{ margin: 0, color: 'var(--ps-color-muted-text)' }}>{t('kaizen.list.empty')}</p>
        </Card>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 320px), 1fr))', gap: 12 }}>
          {rows.map((c) => (
            <li key={c.card_no}>
              <button
                type="button"
                onClick={() => setOpenNo(c.card_no)}
                className="ps-card ps-kaizen-tile"
                style={{
                  all: 'unset',
                  boxSizing: 'border-box',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  width: '100%',
                  height: '100%',
                  padding: 14,
                  borderRadius: 'var(--ps-card-radius, 8px)',
                  background: 'var(--ps-card-bg)',
                  border: `1px solid ${c.is_overdue ? 'var(--ps-color-alert)' : 'var(--ps-color-border)'}`,
                  borderInlineStart: `4px solid ${options.colorOf(c.priority_id)}`,
                  cursor: 'pointer',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                  <span style={{ fontWeight: 800, color: 'var(--ps-color-muted-text)' }}>#{c.card_no}</span>
                  <StatusPill status={c.status} overdue={c.is_overdue} />
                </div>
                <div dir="auto" style={{ fontSize: 15, fontWeight: 700, overflowWrap: 'anywhere', textAlign: 'start' }}>{c.card_name}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', fontSize: 12.5, color: 'var(--ps-color-muted-text)' }}>
                  <span>{c.card_date}</span>
                  <ValueTag id={c.department_id} options={options} />
                  <ValueTag id={c.priority_id} options={options} />
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--ps-color-muted-text)' }}>
                  {t('kaizen.f.responsible')}: {c.responsible_party ?? t('kaizen.notAssigned')}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** One card, all fields. Uses the list row when it's there; fetches it when opened by link. */
function OpenCard({
  no,
  fromList,
  options,
  canEdit,
  onBack,
}: {
  no: number;
  fromList?: KaizenCard;
  options: ReturnType<typeof useKaizenOptions>;
  canEdit: boolean;
  onBack: () => void;
}) {
  const { token } = useAuth();
  const { t } = useLanguage();
  const [card, setCard] = useState<KaizenCard | null | undefined>(fromList);

  useEffect(() => {
    if (fromList || !token) return;
    kaizenApi.getCard(token, no).then((r) => setCard(r.card)).catch(() => setCard(null));
  }, [fromList, no, token]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 860 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={onBack}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 8, border: '1px solid var(--ps-color-border)', background: 'var(--ps-color-surface)', color: 'var(--ps-color-text)', cursor: 'pointer', fontSize: 13 }}
        >
          <ArrowLeft size={15} className="ps-rtl-flip" />
          {t('kaizen.detailsLink')}
        </button>
        {canEdit && card && (
          <Link
            href={`${KAIZEN_BASE}/manage/${card.card_no}`}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 8, background: 'var(--ps-color-accent)', color: 'var(--ps-color-on-accent)', textDecoration: 'none', fontSize: 13, fontWeight: 600 }}
          >
            <Pencil size={14} />
            {t('kaizen.edit')}
          </Link>
        )}
      </div>
      <Card>
        {card === undefined ? (
          <p style={{ margin: 0 }}>{t('shell.loading')}</p>
        ) : card === null ? (
          <p style={{ margin: 0, color: 'var(--ps-color-muted-text)' }}>{t('kaizen.notFound')}</p>
        ) : (
          <CardDetail card={card} options={options} />
        )}
      </Card>
    </div>
  );
}
