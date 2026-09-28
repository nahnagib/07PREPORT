'use client';
import React, { useState } from 'react';
import { Button } from '@07ps/ui';
import { useAuth } from '../../lib/AuthProvider';
import { useLanguage } from '../../lib/i18n/LanguageProvider';
import type { MessageKey } from '../../lib/i18n/messages';
import { ApiError } from '../../lib/api';
import { errorCode, kaizenApi, todayIso, type KaizenCard } from '../../lib/kaizen/api';

/** Quick "Close card": asks for the Closer Date (default today, not before the card's Date). */
export function CloseCardDialog({ card, onCancel, onClosed }: { card: KaizenCard; onCancel: () => void; onClosed: (card: KaizenCard) => void }) {
  const { token } = useAuth();
  const { t } = useLanguage();
  const [date, setDate] = useState(() => (todayIso() < card.card_date ? card.card_date : todayIso()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      onClosed((await kaizenApi.closeCard(token, card.card_no, date)).card);
    } catch (err) {
      const code = errorCode(err);
      setError(code ? t(`err.${code}` as MessageKey) : err instanceof ApiError ? err.message : t('err.generic'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="kaizen-close-title"
      onClick={(e) => e.target === e.currentTarget && onCancel()}
      style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
    >
      <form
        onSubmit={submit}
        className="ps-card"
        style={{ width: 'min(420px, 100%)', background: 'var(--ps-card-bg)', border: '1px solid var(--ps-color-border)', borderRadius: 12, padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}
      >
        <h2 id="kaizen-close-title" style={{ margin: 0, fontSize: 17 }}>
          {t('kaizen.closeDialogTitle', { no: card.card_no })}
        </h2>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--ps-color-muted-text)' }}>
          {card.card_name} — {t('kaizen.closeDialogText')}
        </p>
        <label className="ps-kaizen-field">
          <span>{t('kaizen.f.closerDate')}</span>
          <input className="ps-kaizen-input" type="date" required value={date} min={card.card_date} onChange={(e) => setDate(e.target.value)} aria-invalid={Boolean(error)} autoFocus />
        </label>
        {error && <p role="alert" style={{ margin: 0, fontSize: 13, color: 'var(--ps-color-alert)' }}>{error}</p>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>{t('kaizen.cancel')}</Button>
          <Button type="submit" disabled={busy || !date}>{busy ? t('kaizen.saving') : t('kaizen.confirmClose')}</Button>
        </div>
      </form>
    </div>
  );
}
