import { describe, expect, it } from 'vitest';
import {
  AGEING_BUCKETS,
  CLOSE_HOURS,
  NPS_SLA,
  ageingBucket,
  caseSla,
  resolutionAgeing,
} from '../npsSla';

const CREATED = '2026-11-01 08:00:00';
/** `h` hours after CREATED, as Tripoli wall-clock text */
const at = (h: number) =>
  new Date(Date.parse('2026-11-01T08:00:00Z') + h * 3_600_000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
const open = (ageH: number, contactedAfterH: number | null = null, stage = 'NEW') =>
  caseSla(
    {
      stage,
      createdAt: CREATED,
      contactedAt: contactedAfterH === null ? null : at(contactedAfterH),
      resolvedAt: null,
    },
    at(ageH),
  );
const resolved = (tookH: number) =>
  caseSla(
    { stage: 'RESOLVED', createdAt: CREATED, contactedAt: at(1), resolvedAt: at(tookH) },
    at(400),
  );

describe('the SLA limits', () => {
  it('contact within 24 h, close within 5 days -- the one place they live', () => {
    expect(NPS_SLA).toEqual({ contactHours: 24, closeDays: 5 });
    expect(CLOSE_HOURS).toBe(120);
  });
});

describe('colour rule (every row of the SLA table)', () => {
  it('Open, age <= 24 h: green (contacted or not)', () => {
    expect(open(0)).toMatchObject({ band: 'green', rule: 'open_within_contact', hours: 0 });
    expect(open(24)).toMatchObject({ band: 'green', rule: 'open_within_contact', hours: 24 });
    expect(open(10, 2, 'CONTACTED')).toMatchObject({ band: 'green', contactedInSla: true });
  });
  it('Open, 24 h < age <= 5 d and contacted: amber', () => {
    expect(open(24.1, 3, 'CONTACTED')).toMatchObject({ band: 'amber', rule: 'open_contacted' });
    expect(open(120, 30, 'IN_PROGRESS')).toMatchObject({
      band: 'amber',
      rule: 'open_contacted',
      contactedInSla: false,
    });
  });
  it('Open, age > 24 h and not contacted: red, contact SLA missed', () => {
    expect(open(24.1)).toMatchObject({ band: 'red', rule: 'contact_missed', overByHours: 0.1 });
    expect(open(100)).toMatchObject({ band: 'red', rule: 'contact_missed', overByHours: 76 });
  });
  it('Open, age > 5 d: red, close SLA missed (contacted or not)', () => {
    expect(open(120.1, 2, 'CONTACTED')).toMatchObject({
      band: 'red',
      rule: 'close_missed',
      overByHours: 0.1,
    });
    expect(open(792)).toMatchObject({ band: 'red', rule: 'close_missed', overByHours: 672 }); // 28.0 d past
  });
  it('Resolved within 5 d: green; after 5 d: red', () => {
    expect(resolved(120)).toMatchObject({ band: 'green', rule: 'resolved_in_sla', hours: 120 });
    expect(resolved(120.5)).toMatchObject({ band: 'red', rule: 'resolved_late', overByHours: 0.5 });
  });
  it('Unresolved / Historical: grey, no SLA', () => {
    expect(
      caseSla(
        { stage: 'UNRESOLVED', createdAt: CREATED, contactedAt: null, resolvedAt: null },
        at(500),
      ),
    ).toMatchObject({ band: 'grey', rule: 'unresolved', hours: null });
    expect(
      caseSla(
        { stage: 'HISTORICAL', createdAt: CREATED, contactedAt: null, resolvedAt: null },
        at(500),
      ),
    ).toMatchObject({ band: 'grey', rule: 'historical', hours: null });
  });
  it('time runs from created_at, never negative', () => {
    expect(
      caseSla(
        {
          stage: 'RESOLVED',
          createdAt: CREATED,
          contactedAt: null,
          resolvedAt: '2026-10-30 08:00:00',
        },
        at(1),
      ).hours,
    ).toBe(0);
  });
  it('counts Friday and Saturday as calendar time; exact seconds decide contact and close compliance', () => {
    expect(
      caseSla(
        { stage: 'NEW', createdAt: '2026-11-05 12:00:00', contactedAt: null, resolvedAt: null },
        '2026-11-07 12:00:00',
      ),
    ).toMatchObject({ exactHours: 48, rule: 'contact_missed' });
    expect(open(25, 24, 'CONTACTED').contactedInSla).toBe(true);
    expect(open(25, 24 + 1 / 3600, 'CONTACTED').contactedInSla).toBe(false);
    expect(resolved(120 + 1 / 3600)).toMatchObject({ hours: 120, band: 'red' });
  });
});

describe('Resolved Ageing', () => {
  it('six buckets; the Close SLA line sits between 2-5 d and 5-10 d', () => {
    expect(AGEING_BUCKETS.map((b) => [b.label, b.withinSla])).toEqual([
      ['≤ 1 d', true],
      ['1–2 d', true],
      ['2–5 d', true],
      ['5–10 d', false],
      ['10–30 d', false],
      ['> 30 d', false],
    ]);
    expect([0, 24, 24.1, 48, 120, 120.1, 240, 720, 720.1].map(ageingBucket)).toEqual([
      'd1',
      'd1',
      'd2',
      'd2',
      'd5',
      'd10',
      'd10',
      'd30',
      'dmax',
    ]);
    expect([24, 48, 120, 240, 720].map((h) => ageingBucket(h + 1 / 3600))).toEqual([
      'd2',
      'd5',
      'd10',
      'd30',
      'dmax',
    ]);
  });

  it('resolved by time to resolve, open by age; close share uses resolved cases and contact share excludes fresh pending cases', () => {
    const c = (sla: ReturnType<typeof caseSla>, stage: string, contacted: boolean) => ({
      sla,
      stage,
      contacted,
    });
    const out = resolutionAgeing([
      c(resolved(20), 'RESOLVED', true), //            d1 resolved, closed in SLA, contacted after 1 h
      c(resolved(200), 'RESOLVED', true), //           d10 resolved, closed late
      c(open(10), 'NEW', false), //                    d1 open, no deadline passed yet (left out of both lines)
      c(open(50, 30, 'CONTACTED'), 'CONTACTED', true), // d5 open, contacted late (30 h)
      c(open(130), 'NEW', false), //                   d10 open, close + contact missed
      c(
        caseSla(
          { stage: 'UNRESOLVED', createdAt: CREATED, contactedAt: null, resolvedAt: null },
          at(10),
        ),
        'UNRESOLVED',
        false,
      ), // left out
      c(
        caseSla(
          { stage: 'HISTORICAL', createdAt: CREATED, contactedAt: at(1), resolvedAt: null },
          at(500),
        ),
        'HISTORICAL',
        true,
      ),
    ]);
    const by = Object.fromEntries(out.buckets.map((b) => [b.key, [b.resolved, b.open]]));
    expect(by).toEqual({
      d1: [1, 1],
      d2: [0, 0],
      d5: [0, 1],
      d10: [1, 1],
      d30: [0, 0],
      dmax: [0, 0],
    });
    expect(out.closedInSla).toEqual({ count: 1, of: 2 }); // 2 resolved; open cases are not closed
    expect(out.contactedInSla).toEqual({ count: 2, of: 4 }); // 3 contacted + 1 open over 24 h without contact
  });

  it('returns all six empty buckets and zero denominators when no case has an SLA', () => {
    const out = resolutionAgeing([]);
    expect(out.buckets).toHaveLength(6);
    expect(out.buckets.every((b) => b.open === 0 && b.resolved === 0)).toBe(true);
    expect(out.closedInSla).toEqual({ count: 0, of: 0 });
    expect(out.contactedInSla).toEqual({ count: 0, of: 0 });
  });
});

it('Unresolved is a disputed outcome with no open or resolution SLA', () => {
  expect(caseSla({ stage: 'UNRESOLVED', createdAt: '2026-10-01 09:00:00', contactedAt: null, resolvedAt: null }, '2026-11-09 12:00:00')).toMatchObject({ rule: 'unresolved', band: 'grey', hours: null });
});
