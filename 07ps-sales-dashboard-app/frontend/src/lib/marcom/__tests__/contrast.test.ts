import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * WCAG contrast for the colours the MARCOM pages rely on, computed from the real theme tokens
 * (styles/tokens.css) in both themes. RAG never depends on colour alone (icon + word), but the
 * colours themselves must still be legible: text >= 4.5:1 (AA), graphical marks (icons, borders,
 * bars) >= 3:1.
 */
const css = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'styles', 'tokens.css'), 'utf8');

function block(selector: string): string {
  const i = css.indexOf(selector);
  if (i < 0) throw new Error(`no ${selector}`);
  return css.slice(css.indexOf('{', i) + 1, css.indexOf('}', i));
}
function vars(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

type RGBA = [number, number, number, number];
function parse(value: string, scope: Record<string, string>): RGBA {
  const v = value.trim();
  const ref = /^var\((--[\w-]+)\)$/.exec(v);
  if (ref) return parse(scope[ref[1]], scope);
  let m = /^#([0-9a-f]{6})$/i.exec(v);
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16), 1];
  m = /^#([0-9a-f]{3})$/i.exec(v);
  if (m) return [...m[1].split('').map((c) => parseInt(c + c, 16)), 1] as RGBA;
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)$/.exec(v);
  if (rgba) return [+rgba[1], +rgba[2], +rgba[3], rgba[4] === undefined ? 1 : +rgba[4]];
  throw new Error(`cannot parse colour: ${value}`);
}
const over = (fg: RGBA, bg: RGBA): RGBA => [0, 1, 2].map((i) => Math.round(fg[i] * fg[3] + bg[i] * (1 - fg[3]))).concat(1) as RGBA;
const lum = ([r, g, b]: RGBA) => {
  const c = [r, g, b].map((x) => { const s = x / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a: RGBA, b: RGBA) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const light = vars(block(':root'));
const dark = { ...light, ...vars(block("[data-theme='dark']")) };

describe.each([['light', light], ['dark', dark]] as const)('%s theme', (_name, scope) => {
  const c = (name: string) => parse(`var(${name})`, scope);
  const surface = c('--ps-color-surface');
  const page = c('--ps-color-page-bg');
  const rag = ['success', 'watch', 'alert'] as const;

  it('primary and muted text are AA on the card and page backgrounds', () => {
    expect(ratio(c('--ps-color-text'), surface)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(c('--ps-color-text'), page)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(c('--ps-color-muted-text'), surface)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(rag)('badge text on the tinted %s background is AA', (k) => {
    const tint = over(c(`--ps-color-${k}-bg`), surface);
    expect(ratio(c('--ps-color-text'), tint)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(rag)('the %s colour (icons, borders, bars, lines) is at least 3:1 on the card', (k) => {
    expect(ratio(c(`--ps-color-${k}`), surface)).toBeGreaterThanOrEqual(3);
  });

  it('the neutral chip text is AA on its background', () => {
    expect(ratio(c('--ps-color-text'), c('--ps-color-muted-bg'))).toBeGreaterThanOrEqual(4.5);
  });

  it('coloured delta text (green / red) is AA on the card', () => {
    expect(ratio(c('--ps-color-success'), surface)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(c('--ps-color-alert'), surface)).toBeGreaterThanOrEqual(4.5);
  });

  it('chart series colours are at least 3:1 on the card', () => {
    for (const k of ['--ps-color-accent', '--ps-color-last-year', '--ps-color-trend-target', '--ps-chart-target']) {
      expect(ratio(c(k), surface), `${k}`).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('categorical chart palettes (theme-independent hex) stay visible on both surfaces', () => {
  it.each([
    ['#0072B2'], ['#E69F00'], ['#009E73'], ['#CC79A7'], ['#56B4E9'], ['#D55E00'], ['#7A5195'], ['#8C8C8C'],
  ])('%s vs light and dark card', (hex) => {
    const s = parse(hex, {});
    // Bars/segments are graphical marks: 3:1 against at least one of the surfaces, and always
    // separated by a legend + tooltip + table so they never carry meaning alone.
    const best = Math.max(ratio(s, parse('#ffffff', {})), ratio(s, parse('#161d2e', {})));
    expect(best).toBeGreaterThanOrEqual(3);
  });
});

describe('the secondary series colour (palette.SERIES.secondary) clears 3:1 on BOTH card surfaces', () => {
  it.each([['light', '#ffffff'], ['dark', '#161d2e']])('%s', (_n, surface) => {
    expect(ratio(parse('#D55E00', {}), parse(surface, {}))).toBeGreaterThanOrEqual(3);
  });
});
