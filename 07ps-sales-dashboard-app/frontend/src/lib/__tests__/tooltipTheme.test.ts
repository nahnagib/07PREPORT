import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { TOOLTIP_TOKENS, chartTooltipProps, tooltipBoxStyle, tooltipColors } from '@07ps/ui';

/**
 * The shared tooltip theme (packages/ui chartTooltip.ts + the --ps-tooltip-* tokens in styles/tokens.css): light text in
 * dark mode, dark text in light mode, WCAG AA (4.5:1) in both, and every chart reads the tokens instead of a fixed colour.
 */
const css = fs.readFileSync(path.join(__dirname, '..', '..', 'styles', 'tokens.css'), 'utf8');

function block(selector: string): string {
  const i = css.indexOf(selector);
  if (i < 0) throw new Error(`no ${selector}`);
  return css.slice(css.indexOf('{', i) + 1, css.indexOf('}', i));
}
function cssVar(text: string, name: string): string {
  const m = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(text);
  if (!m) throw new Error(`no ${name}`);
  return m[1].trim().toLowerCase();
}
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const THEME_BLOCKS = { light: block(':root {'), dark: block("[data-theme='dark'] {") } as const;

describe('shared tooltip theme', () => {
  it('returns light text on a dark box for dark mode, and dark text on a light box for light mode', () => {
    const dark = tooltipColors('dark');
    const light = tooltipColors('light');
    expect(luminance(dark.fg)).toBeGreaterThan(0.7);
    expect(luminance(dark.bg)).toBeLessThan(0.05);
    expect(luminance(light.fg)).toBeLessThan(0.05);
    expect(luminance(light.bg)).toBeGreaterThan(0.9);
  });

  it.each(['light', 'dark'] as const)('meets WCAG AA (4.5:1) for tooltip text and muted text in %s mode', (mode) => {
    const { bg, fg, muted } = tooltipColors(mode);
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(muted, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(['light', 'dark'] as const)('tokens.css carries the same %s values as TOOLTIP_TOKENS', (mode) => {
    const t = TOOLTIP_TOKENS[mode];
    for (const [key, value] of Object.entries({ bg: t.bg, fg: t.fg, muted: t.muted, border: t.border })) {
      expect(cssVar(THEME_BLOCKS[mode], `--ps-tooltip-${key}`)).toBe(value);
    }
  });

  it('charts read the tokens (never a series colour or #000), so a theme switch restyles open tooltips', () => {
    expect(chartTooltipProps.itemStyle.color).toBe('var(--ps-tooltip-fg)');
    expect(chartTooltipProps.labelStyle.color).toBe('var(--ps-tooltip-fg)');
    expect(chartTooltipProps.contentStyle.background).toBe('var(--ps-tooltip-bg)');
    expect(tooltipBoxStyle.color).toBe('var(--ps-tooltip-fg)');
    expect((tooltipBoxStyle as Record<string, unknown>)['--ps-color-muted-text']).toBe('var(--ps-tooltip-muted)');
  });

  it('every Recharts <Tooltip> in the app spreads chartTooltipProps', () => {
    const roots = [path.join(__dirname, '..', '..'), path.join(__dirname, '..', '..', '..', '..', 'packages', 'ui', 'src')];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules' && entry.name !== '__tests__') walk(full);
        } else if (entry.name.endsWith('.tsx')) {
          const text = fs.readFileSync(full, 'utf8');
          for (const m of text.matchAll(/<Tooltip(?=[\s/>])([^>]{0,40})/g)) {
            if (!m[1].includes('{...chartTooltipProps}')) offenders.push(path.relative(roots[0], full));
          }
        }
      }
    };
    roots.forEach(walk);
    expect(offenders).toEqual([]);
  });
});
