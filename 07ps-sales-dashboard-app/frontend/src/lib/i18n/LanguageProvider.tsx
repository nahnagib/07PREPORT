'use client';
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { MESSAGES, type MessageKey } from './messages';

export type Lang = 'en' | 'ar';

const STORAGE_KEY = 'ps_lang';

interface LanguageContextValue {
  lang: Lang;
  dir: 'ltr' | 'rtl';
  setLang: (lang: Lang) => void;
  toggle: () => void;
  /** Translated text for `key`; `{name}` placeholders are filled from `vars`. */
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  /** Picks the English or Arabic variant of a value that carries both (e.g. a dropdown label). */
  pick: (en: string, ar: string | null | undefined) => string;
  /** Number formatting in the current language (Arabic keeps Western digits, like the source data). */
  formatNumber: (value: number, maximumFractionDigits?: number) => string;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

/**
 * Platform-level EN/AR switch, next to the dark-mode toggle (same "platform-level, not
 * per-dashboard" rule as ThemeProvider). The choice is remembered per browser (localStorage) and
 * applied as <html lang dir>, so RTL mirrors every flex/grid layout that uses logical properties.
 * Pages translate their own text through `t()`; the Kaizen Board is fully translated, while the
 * older sales reports keep their English content for now (only the shared shell is translated).
 */
export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>('en');

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === 'ar' || stored === 'en') setLangState(stored);
    } catch {
      // Storage unavailable (private mode) -- English default.
    }
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('lang', lang);
    document.documentElement.setAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
  }, [lang]);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore
    }
  }, []);

  const t = useCallback(
    (key: MessageKey, vars?: Record<string, string | number>) => {
      let text: string = MESSAGES[lang][key] ?? MESSAGES.en[key] ?? key;
      if (vars) for (const [k, v] of Object.entries(vars)) text = text.split(`{${k}}`).join(String(v));
      return text;
    },
    [lang],
  );

  const pick = useCallback((en: string, ar: string | null | undefined) => (lang === 'ar' && ar ? ar : en), [lang]);

  const formatNumber = useCallback(
    (value: number, maximumFractionDigits = 0) => value.toLocaleString(lang === 'ar' ? 'ar-LY-u-nu-latn' : 'en-US', { maximumFractionDigits }),
    [lang],
  );

  return (
    <LanguageContext.Provider
      value={{ lang, dir: lang === 'ar' ? 'rtl' : 'ltr', setLang, toggle: () => setLang(lang === 'ar' ? 'en' : 'ar'), t, pick, formatNumber }}
    >
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error('useLanguage must be used within LanguageProvider');
  return ctx;
}
