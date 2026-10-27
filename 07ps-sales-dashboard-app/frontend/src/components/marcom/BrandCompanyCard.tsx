'use client';
import React, { useCallback, useEffect, useState } from 'react';
import { Card } from '@07ps/ui';
import { marcomApi, MarcomApiError, type BrandCompanies } from '../../lib/marcomApi';

/**
 * "Brand -> Company" on the MARCOM Upload page (migration 0057). MARCOM data is uploaded per brand;
 * linking each brand to a company lets the report pages filter and group by Company. Brands left
 * unassigned show as "Unassigned" in the By Company views.
 */
export function BrandCompanyCard({ token, canEdit }: { token: string | null; canEdit: boolean }) {
  const [data, setData] = useState<BrandCompanies | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<number | null>(null);
  const [saved, setSaved] = useState<number | null>(null);

  const load = useCallback(() => {
    if (!token) return;
    setError(null);
    marcomApi.listBrandCompanies(token)
      .then(setData)
      .catch((err) => setError(err instanceof MarcomApiError ? err.message : 'Could not load the brands.'));
  }, [token]);
  useEffect(() => { load(); }, [load]);

  async function change(brandId: number, raw: string) {
    if (!token || !data) return;
    const companyKey = raw === '' ? null : Number(raw);
    setSaving(brandId);
    setSaved(null);
    setError(null);
    try {
      const row = await marcomApi.setBrandCompany(token, brandId, companyKey);
      setData({ ...data, brands: data.brands.map((b) => (b.brandId === brandId ? row : b)) });
      setSaved(brandId);
    } catch (err) {
      setError(err instanceof MarcomApiError ? err.message : 'Could not save.');
    } finally {
      setSaving(null);
    }
  }

  const unassigned = data?.brands.filter((b) => b.companyKey === null).length ?? 0;

  return (
    <Card>
      <div data-testid="brand-company-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div>
          <h2 style={{ fontSize: 16, margin: 0 }}>Brand → Company</h2>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--ps-color-muted-text)' }}>
            Link each MARCOM brand to its company. The report pages use this for the Company filter and the &quot;By Company&quot; views.
            {unassigned > 0 && <strong style={{ color: 'var(--ps-color-text)' }}> {unassigned} brand{unassigned === 1 ? '' : 's'} not assigned yet.</strong>}
          </p>
        </div>
        {error && <div role="alert" style={{ fontSize: 13, color: 'var(--ps-color-alert)' }}>{error} <button type="button" onClick={load} style={{ marginInlineStart: 6, fontSize: 12 }}>Retry</button></div>}
        {!data && !error && <div style={{ fontSize: 13, color: 'var(--ps-color-muted-text)' }}>Loading…</div>}
        {data && data.brands.length === 0 && <div style={{ fontSize: 13, color: 'var(--ps-color-muted-text)' }}>No brands yet — they are created by the first upload.</div>}
        {data && data.brands.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'start', padding: '6px 8px', fontSize: 12, color: 'var(--ps-color-muted-text)', borderBottom: '1px solid var(--ps-color-border)' }}>Brand</th>
                <th style={{ textAlign: 'start', padding: '6px 8px', fontSize: 12, color: 'var(--ps-color-muted-text)', borderBottom: '1px solid var(--ps-color-border)' }}>Company</th>
                <th style={{ width: 80, borderBottom: '1px solid var(--ps-color-border)' }} />
              </tr>
            </thead>
            <tbody>
              {data.brands.map((b) => (
                <tr key={b.brandId} data-testid="brand-company-row">
                  <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--ps-color-border)' }}>{b.brand}</td>
                  <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--ps-color-border)' }}>
                    <select
                      aria-label={`Company for ${b.brand}`}
                      value={b.companyKey === null ? '' : String(b.companyKey)}
                      disabled={!canEdit || saving === b.brandId}
                      onChange={(e) => change(b.brandId, e.target.value)}
                      style={{ fontSize: 13, padding: '5px 8px', borderRadius: 6, border: '1px solid var(--ps-color-border)', background: 'var(--ps-color-surface)', color: 'var(--ps-color-text)', minWidth: 200 }}
                    >
                      <option value="">— Unassigned —</option>
                      {data.companies.map((c) => <option key={c.companyKey} value={c.companyKey}>{c.company}</option>)}
                      {b.companyKey !== null && !data.companies.some((c) => c.companyKey === b.companyKey) && <option value={b.companyKey}>{b.company ?? `#${b.companyKey}`} (inactive)</option>}
                    </select>
                  </td>
                  <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--ps-color-border)', fontSize: 12, color: 'var(--ps-color-muted-text)' }}>
                    {saving === b.brandId ? 'Saving…' : saved === b.brandId ? '✔ Saved' : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Card>
  );
}
