'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../lib/AuthProvider';
import { useLanguage } from '../../lib/i18n/LanguageProvider';
import { kaizenApi, type KaizenDropdownValue, type KaizenListKey, type KaizenOptions } from '../../lib/kaizen/api';

/** Dropdown values + autocomplete lists, with label/colour lookups in the current language.
 * `listValues(key)` gives every value (for filters and labels, inactive ones included, since old
 * cards keep them); `activeValues(key)` gives only what the entry form may offer. */
export function useKaizenOptions() {
  const { token } = useAuth();
  const { pick } = useLanguage();
  const [options, setOptions] = useState<KaizenOptions | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    kaizenApi
      .options(token)
      .then(setOptions)
      .catch((err) => setError(err instanceof Error ? err.message : 'error'));
  }, [token]);

  const byId = useMemo(() => new Map((options?.dropdowns ?? []).map((d) => [d.value_id, d])), [options]);

  const listValues = useCallback(
    (key: KaizenListKey): KaizenDropdownValue[] => (options?.dropdowns ?? []).filter((d) => d.list_key === key),
    [options],
  );
  const activeValues = useCallback((key: KaizenListKey) => listValues(key).filter((d) => d.is_active), [listValues]);
  const labelOf = useCallback(
    (id: number | null | undefined) => {
      const d = id == null ? undefined : byId.get(id);
      return d ? pick(d.label_en, d.label_ar) : '—';
    },
    [byId, pick],
  );
  const colorOf = useCallback((id: number) => byId.get(id)?.color ?? 'var(--ps-color-neutral-text)', [byId]);

  return { options, error, loading: !options && !error, listValues, activeValues, labelOf, colorOf, byId };
}
