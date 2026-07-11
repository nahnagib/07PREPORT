import type { Config } from 'tailwindcss';

/**
 * Standards Section 3.9-3.10 - color and typography tokens, mirrored 1:1 from
 * packages/ui/src/tokens so Tailwind utilities and the shared component library never drift.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}', '../packages/ui/src/**/*.{ts,tsx}'],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        surface: 'var(--ps-color-surface)',
        border: 'var(--ps-color-border)',
        text: 'var(--ps-color-text)',
        muted: 'var(--ps-color-muted-text)',
        accent: 'var(--ps-color-accent)',
        success: 'var(--ps-color-success)',
        watch: 'var(--ps-color-watch)',
        alert: 'var(--ps-color-alert)',
      },
      borderRadius: {
        card: '8px',
      },
      fontFamily: {
        sans: ['Cairo', 'Inter', 'system-ui', 'sans-serif'],
      },
      screens: {
        tablet: '768px',
        desktop: '1280px',
      },
    },
  },
  plugins: [],
};
export default config;
