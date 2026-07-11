'use client';
import React, { createContext, useContext, useEffect, useState } from 'react';

type Theme = 'light' | 'dark';
const ThemeContext = createContext<{ theme: Theme; toggle: () => void } | null>(null);

/**
 * Standards Section 3.19 - Dark Mode Strategy: "a platform-level toggle (not per-dashboard)."
 *
 * Tachometer rebuild (dark-theme pass): default theme flipped to 'dark', per the new mockup's
 * explicit "Dark mode execution" framing (dark is the primary/first-run experience; light remains
 * a full, equally-supported alternative one toggle click away -- nothing about light mode was
 * removed or degraded).
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>('dark');

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  return (
    <ThemeContext.Provider value={{ theme, toggle: () => setTheme((t) => (t === 'light' ? 'dark' : 'light')) }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
