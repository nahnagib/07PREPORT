import React from 'react';
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NameTick, fitEnd, labelColumnWidth, textWidth } from '../ProductBarChart';
const stripIsolates = (t: string) => t.replace(/[⁦-⁩]/g, '');

afterEach(cleanup);
const tick = (name: string, company: string, width = 280) =>
  render(<svg><NameTick x={0} y={0} width={width} row={{ id: '1', name, company, value: 1, valueLabel: '1' }} /></svg>);

it('cuts an overlong name at the END, never at the start', () => {
  const cut = fitEnd('MORTERO JUNTA PERLA 5KG', textWidth('MORTERO JUNTA PER…'));
  expect(cut.startsWith('MORTERO')).toBe(true);
  expect(cut.endsWith('…')).toBe(true);
  expect(fitEnd('Cem Air', 200)).toBe('Cem Air');
});

it('label column = the longest label, between 120 and 280px', () => {
  expect(labelColumnWidth([{ name: 'A', company: '' }])).toBe(120);
  expect(labelColumnWidth([{ name: 'X'.repeat(200), company: 'Majaal' }])).toBe(280);
  const mid = labelColumnWidth([{ name: 'Xtreme-SuperCol S1', company: 'Majaal' }]);
  expect(mid).toBeGreaterThan(120);
  expect(mid).toBeLessThan(280);
});

it('the axis label is the name as a first-strong isolate, then the company tag', () => {
  tick('متين GERMA-C2TE', 'Tika');
  const label = screen.getByTestId('product-bar-label');
  expect(label.getAttribute('direction')).toBe('ltr');
  // text nodes: <title>, the isolated name, the company tag
  expect(label.textContent).toContain('⁨متين GERMA-C2TE⁩ · Tika');
});

it('look-alike names of the two companies stay apart; a long name is cut before the tag', () => {
  tick('Xtreme - SuperCol S1', 'Tika');
  tick('Xtreme-SuperCol S1', 'Majaal');
  tick('MORTERO JUNTA PERLA 5KG EXTRA LONG NAME', 'Majaal', 150);
  const shown = screen.getAllByTestId('product-bar-label').map((e) => stripIsolates(Array.from(e.childNodes).filter((n) => n.nodeName !== 'title').map((n) => n.textContent).join('')));
  expect(shown[0]).toBe('Xtreme - SuperCol S1 · Tika');
  expect(shown[1]).toBe('Xtreme-SuperCol S1 · Majaal');
  expect(shown[2]).toMatch(/^MORTERO.*… · Majaal$/);
});
