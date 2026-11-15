import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import {
  NPS_SLA,
  SLA_COLOR,
  slaHint,
  slaShareText,
  type CaseSla,
  type SlaRule,
} from '../../../lib/nps/sla';
import type { FollowupCase, FollowupKpis } from '../../../lib/nps/followup';

vi.mock('next/navigation', () => ({ usePathname: () => '/process/nps-followup' }));
vi.mock('../../../lib/AuthProvider', () => ({
  useAuth: () => ({ user: null, canView: () => true }),
}));

const { CaseCard, NotClassifiedKpi, SlaKpis, TimeOpen } = await import('../FollowupBits');

afterEach(cleanup);

const sla = (
  rule: SlaRule,
  band: CaseSla['band'],
  hours: number | null,
  overByHours: number | null = null,
): CaseSla => ({ band, rule, hours, exactHours: hours, overByHours, contactedInSla: null });

describe('the SLA limits', () => {
  it('match the backend (backend/src/config/npsSla.ts): contact 24 h, close 5 d', () => {
    expect(NPS_SLA).toEqual({ contactHours: 24, closeDays: 5 });
    const backend = fs.readFileSync(
      path.resolve(__dirname, '../../../../../backend/src/config/npsSla.ts'),
      'utf8',
    );
    expect(backend).toContain(
      `export const NPS_SLA = { contactHours: ${NPS_SLA.contactHours}, closeDays: ${NPS_SLA.closeDays} } as const;`,
    );
  });
});

describe('time column: one row per rule of the SLA table', () => {
  const rows: [string, CaseSla, string, string, string][] = [
    [
      'NEW',
      sla('open_within_contact', 'green', 5),
      'green',
      'open 5 h',
      'Within SLA: open at most 24 h (contact by 24 h, close by 5 d)',
    ],
    [
      'CONTACTED',
      sla('open_contacted', 'amber', 60),
      'amber',
      'open 2.5 d',
      'Contacted; Close SLA (5 d) still ahead: 2.5 d left',
    ],
    [
      'NEW',
      sla('contact_missed', 'red', 30, 6),
      'red',
      'open 30 h',
      'Contact SLA missed: not contacted after 24 h',
    ],
    [
      'IN_PROGRESS',
      sla('close_missed', 'red', 792, 672),
      'red',
      'open 33.0 d',
      'Close SLA missed by 28.0 d',
    ],
    [
      'RESOLVED',
      sla('resolved_in_sla', 'green', 20),
      'green',
      'resolved in 20 h',
      'Closed within SLA (5 d)',
    ],
    [
      'RESOLVED',
      sla('resolved_late', 'red', 168, 48),
      'red',
      'resolved in 7.0 d',
      'Close SLA missed by 2.0 d',
    ],
    ['UNRESOLVED', sla('unresolved', 'grey', null), 'grey', 'unresolved', 'Unresolved: no SLA'],
    ['UNRESOLVED', sla('unresolved', 'grey', null), 'grey', 'unresolved', 'Unresolved: no SLA'],
    [
      'HISTORICAL',
      sla('historical', 'grey', null),
      'grey',
      'historical',
      'Historical (rated before the follow-up started): no SLA',
    ],
  ];
  it.each(rows)('%s / %s', (stage, s, band, text, hint) => {
    render(<TimeOpen c={{ stage: stage as FollowupCase['stage'], hoursOpen: s.hours, sla: s }} />);
    const el = screen.getByTestId('fu-time');
    expect(el.getAttribute('data-band')).toBe(band);
    expect(el.textContent).toBe(text);
    expect(el.getAttribute('title')).toBe(hint);
    expect(slaHint(s)).toBe(hint);
    expect(el.style.color).toBe(SLA_COLOR[band as CaseSla['band']]);
    expect(el.querySelector('svg')).toBeTruthy(); // the icon: the second cue next to the colour
  });

  it('nothing before the case exists', () => {
    const { container } = render(<TimeOpen c={{ stage: 'NEW', hoursOpen: null, sla: null }} />);
    expect(container.textContent).toBe('');
  });

  it('the SLA colours are the validated follow-up palette', () => {
    expect(SLA_COLOR).toEqual({
      green: 'var(--ps-sla-green)',
      amber: 'var(--ps-sla-amber)',
      red: 'var(--ps-sla-red)',
      grey: 'var(--ps-color-neutral-text)',
    });
  });
});

describe('board card', () => {
  it('the card edge takes the SLA colour; grey cases keep the plain border', () => {
    const base = {
      caseId: 7,
      orderRef: 'S7',
      customer: 'X',
      company: 'MAJAAL',
      stage: 'NEW',
      status: 'OPEN',
      hasComment: false,
      sourceChanged: false,
    } as unknown as FollowupCase;
    const { unmount } = render(
      <CaseCard
        c={{ ...base, hoursOpen: 30, sla: sla('contact_missed', 'red', 30, 6) }}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByTestId('fu-card').getAttribute('data-band')).toBe('red');
    expect(screen.getByTestId('fu-card').style.borderInlineStartColor).toBe('var(--ps-sla-red)');
    expect(screen.getByTestId('fu-time').getAttribute('title')).toBe(
      'Contact SLA missed: not contacted after 24 h',
    );
    unmount();
    render(
      <CaseCard
        c={{
          ...base,
          stage: 'UNRESOLVED',
          status: 'DISPUTED',
          hoursOpen: null,
          sla: sla('unresolved', 'grey', null),
        }}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByTestId('fu-card').style.borderInlineStartColor).toBe(
      'var(--ps-color-border)',
    );
  });
});

describe('board KPIs', () => {
  it('SLA Performance (2026-11-15): Close SLA missed, Contact SLA missed, Resolved with "within SLA (5 d)" -- three cards, no Not classified', () => {
    const kpis = {
      closeSlaMissed: 4,
      contactSlaMissed: 9,
      resolved30Days: 12,
      resolvedInSla: 10,
      noReason: 3,
    } as FollowupKpis;
    render(<SlaKpis kpis={kpis} />);
    const row = screen.getByTestId('fu-kpis-stage');
    expect(row.className).toBe('ps-fu-kpis');
    expect(row.children).toHaveLength(3);
    expect(within(row).queryByText('Not classified')).toBeNull();
    expect(within(row).getByText('Close SLA missed')).toBeTruthy();
    expect(within(row).getByText('open more than 5 days')).toBeTruthy();
    expect(within(row).getByText('Contact SLA missed')).toBeTruthy();
    expect(within(row).getByText('open more than 24 h, not contacted')).toBeTruthy();
    expect(within(row).getByText('10 within SLA (5 d)')).toBeTruthy();
    expect(within(row).queryByText('Open over 5 days')).toBeNull();
  });

  it('Not classified is its own card (shown under Status): every board case without a reason, any status', () => {
    render(<NotClassifiedKpi kpis={{ noReason: 3 } as FollowupKpis} />);
    expect(screen.getByText('Not classified')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('no reason chosen yet (any status)')).toBeTruthy();
  });
});

describe('SLA share text', () => {
  it('x of y (z %), or none due yet', () => {
    expect(slaShareText({ count: 3, of: 4 })).toBe('3 of 4 (75 %)');
    expect(slaShareText({ count: 0, of: 0 })).toBe('— (none due yet)');
  });
});

describe('Board layout (2026-11-15)', () => {
  it('labelled sections in this order: SLA Performance, Status (with Not classified), Stages (note, then the kanban)', () => {
    const page = fs.readFileSync(path.resolve(__dirname, '../../../app/(departments)/process/nps-followup/page.tsx'), 'utf8');
    const at = (needle: string) => {
      const i = page.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    const order = [
      at('>SLA Performance</h2>'), at('<SlaKpis kpis={board.kpis} />'),
      at('>Status</h2>'), at('data-testid="fu-kpis-status"'), at('<NotClassifiedKpi kpis={board.kpis} />'),
      at('>Stages</h2>'), at('New detractors appear as cases within 30 minutes'), at('data-testid="fu-board"'),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(page).toContain('className="ps-fu-section-title"');
  });
});
