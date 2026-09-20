import { describe, expect, it } from 'vitest';
import { csvCell, issuesToCsv } from '../csv';

describe('errors.csv formula-injection escaping', () => {
  it.each(['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\t=x', '\r=x'])('prefixes %j with an apostrophe', (v) => {
    expect(csvCell(v).startsWith(`"'`)).toBe(true);
  });
  it('leaves normal text alone and doubles quotes', () => {
    expect(csvCell('hello "world"')).toBe('"hello ""world"""');
    expect(csvCell('Spend is 0')).toBe('"Spend is 0"');
    expect(csvCell(null)).toBe('""');
  });
  it('escapes every column of every row', () => {
    const csv = issuesToCsv([{ severity: 'error', code: 'X', sheet: '=evil', table: 'spend', cell: '@A1', message: '+boom' }]);
    const lines = csv.replace('\uFEFF', '').trim().split('\r\n');
    expect(lines[0]).toBe('"severity","code","sheet","table","cell","message"');
    expect(lines[1]).toBe(`"error","X","'=evil","spend","'@A1","'+boom"`);
  });
});
