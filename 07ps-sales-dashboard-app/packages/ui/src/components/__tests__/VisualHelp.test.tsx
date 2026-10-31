import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ChartPanel } from '../ChartPanel';
import { KpiCard } from '../KpiCard';
import { InsightCard } from '../InsightCard';
import { mergeInteractions, VisualInfoIcons } from '../VisualHelp';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

const help = { definition: 'Net sales value from 1 Jan to the anchor date.', formula: ['Variance to LYTD = (YTD − LYTD) ÷ LYTD', 'Achievement % = YTD ÷ Target'], notes: 'Credit notes reduce the value.' };
const q = () => screen.queryByRole('button', { name: 'About this visual' });
const i = () => screen.queryByRole('button', { name: 'How to interact' });

describe('"?" and "i" icons', () => {
  it('show or hide per content: help only, interactions only, both, neither (with a dev warning)', () => {
    const { rerender } = render(<VisualInfoIcons title="YTD Value" help={help} />);
    expect(q()).not.toBeNull();
    expect(i()).toBeNull();

    rerender(<VisualInfoIcons title="YTD Value" interactions={['Click the card to see the breakdown']} />);
    expect(q()).toBeNull();
    expect(i()).not.toBeNull();

    rerender(<VisualInfoIcons title="YTD Value" help={help} interactions={['Click the card to see the breakdown']} />);
    const buttons = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'));
    expect(buttons).toEqual(['About this visual', 'How to interact']); // "?" first, then "i"

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    rerender(<VisualInfoIcons title="Nothing to say" />);
    expect(q()).toBeNull();
    expect(i()).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"Nothing to say" has no help and no interactions'));
  });

  it('"?" popover: title, definition, one formula per line, notes', () => {
    render(<VisualInfoIcons title="YTD Value" help={help} />);
    fireEvent.mouseEnter(q()!);
    const pop = screen.getByRole('tooltip');
    expect(pop.textContent).toContain('YTD Value');
    expect(pop.textContent).toContain(help.definition);
    expect(screen.getByTestId('visual-help-formula').children).toHaveLength(2);
    expect(pop.textContent).toContain('Credit notes reduce the value.');
  });

  it('"i" popover: "What you can do" and a bullet list', () => {
    render(<VisualInfoIcons title="Customers Table" interactions={['Sort by clicking a header', 'Export CSV / PDF']} />);
    fireEvent.focus(i()!);
    const pop = screen.getByRole('tooltip');
    expect(pop.textContent).toContain('What you can do');
    expect(pop.querySelectorAll('li')).toHaveLength(2);
  });

  it('opens on hover, keyboard focus and tap; closes on Esc and on a click outside', () => {
    vi.useFakeTimers();
    render(<VisualInfoIcons title="YTD Value" help={help} />);
    const btn = q()!;

    fireEvent.mouseEnter(btn);
    expect(screen.queryByRole('tooltip')).not.toBeNull();
    fireEvent.mouseLeave(btn);
    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.queryByRole('tooltip')).toBeNull();

    fireEvent.focus(btn);
    expect(screen.queryByRole('tooltip')).not.toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();

    fireEvent.click(btn); // tap
    expect(screen.queryByRole('tooltip')).not.toBeNull();
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('a tap on an icon never triggers the clickable card it sits on', () => {
    const onClick = vi.fn();
    render(<KpiCard title="YTD Value" actual={1} targetToDate={2} status="success" actualLabel="LYD 1" referenceMetrics={[]} help={help} onClick={onClick} />);
    fireEvent.click(q()!);
    expect(onClick).not.toHaveBeenCalled();
    expect(screen.queryByRole('tooltip')).not.toBeNull();
  });

  it('the icons are left out of image / PDF exports', () => {
    render(<VisualInfoIcons title="YTD Value" help={help} interactions={['x']} />);
    expect(q()!.closest('[data-html2canvas-ignore="true"]')).not.toBeNull();
  });
});

describe('standard capability lines', () => {

  it('merges the page lines with the component\'s own capabilities, without duplicates', () => {
    expect(mergeInteractions(['Sort by clicking a column header.', 'Click a bar to filter by month'], { sortable: true, expandTable: true }))
      .toEqual(['Sort by clicking a column header.', 'Click a bar to filter by month', 'Expand ⤢ to see the data as a table']);
  });

  it('ChartPanel adds "expand to table" by itself when it has table data; a clickable KpiCard adds the drill line', () => {
    render(
      <ChartPanel title="Trend" help={help} tableColumns={[{ key: 'a', header: 'A' }]} tableRows={[{ a: 1 }]} getRowId={(r) => String(r.a)}>
        <div />
      </ChartPanel>,
    );
    fireEvent.mouseEnter(i()!);
    expect(screen.getByRole('tooltip').textContent).toContain('Expand ⤢ to see the data as a table');
    cleanup();
    render(<KpiCard title="YTD Value" actual={1} targetToDate={2} status="success" actualLabel="LYD 1" referenceMetrics={[]} onClick={() => undefined} />);
    fireEvent.mouseEnter(i()!);
    expect(screen.getByRole('tooltip').textContent).toContain('drill into the details');
  });
});
