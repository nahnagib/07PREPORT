import { describe, expect, it } from 'vitest';
import {
  FollowupValidationError,
  applyEdit,
  followupWhere,
  hoursOpen,
  nowLocal,
  parseFollowupQuery,
  timeBand,
  type FollowupCase,
} from '../npsFollowupService';

const NOW = '2026-10-19 12:00:00';

function aCase(over: Partial<FollowupCase> = {}): FollowupCase {
  return {
    caseId: 1, responseId: 10, ratedAt: '2026-10-15 09:00:00', status: 'NEW', reasonId: null, reasonEn: null, reasonAr: null,
    ownerUserId: null, ownerName: null, contactedAt: null, solvedAt: null, rootCause: null, actionTaken: null, notes: null,
    sourceChanged: false, sourceChangedAt: null, sourceChangeReason: null, version: 1, updatedAt: null, updatedByName: null,
    company: 'MAJAAL', customer: 'x', orderRef: 'S1', deliveryCode: 'WH/OUT/1', salesTeam: null, salesperson: null, teamBranch: null,
    hasComment: false, orderUrl: null, deliveryUrl: null, hoursOpen: null, timeBand: null, ...over,
  };
}

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return err instanceof FollowupValidationError ? err.code : String(err);
  }
  return null;
};

describe('time open', () => {
  it('green under 48 h, yellow from 48 h to 5 days, red after 5 days', () => {
    expect(timeBand(0)).toBe('green');
    expect(timeBand(47.99)).toBe('green');
    expect(timeBand(48)).toBe('yellow');
    expect(timeBand(120)).toBe('yellow');
    expect(timeBand(120.01)).toBe('red');
    expect(timeBand(null)).toBeNull();
  });

  it('runs to now while open, to the solved time once solved, and not at all for cancelled or historical cases', () => {
    expect(hoursOpen(aCase(), NOW)).toBe(99);
    expect(hoursOpen(aCase({ status: 'SOLVED', solvedAt: '2026-10-16 10:00:00' }), NOW)).toBe(25);
    expect(hoursOpen(aCase({ status: 'CANCELLED' }), NOW)).toBeNull();
    expect(hoursOpen(aCase({ status: 'HISTORICAL' }), NOW)).toBeNull();
  });

  it('now is the Tripoli wall clock (UTC+2), not the server zone', () => {
    expect(nowLocal(new Date('2026-10-19T22:30:00Z'))).toBe('2026-10-20 00:30:00');
  });
});

describe('editing a case', () => {
  it('Contacted fills the contact time with now when empty', () => {
    expect(applyEdit(aCase(), { status: 'CONTACTED' }, NOW)).toMatchObject({ status: 'CONTACTED', contactedAt: NOW, solvedAt: null });
  });

  it('Solved needs a reason, fills the solved time, and leaving Solved clears it', () => {
    expect(code(() => applyEdit(aCase(), { status: 'SOLVED' }, NOW))).toBe('case.reasonRequired');
    const solved = applyEdit(aCase(), { status: 'SOLVED', reasonId: 3 }, NOW);
    expect(solved).toMatchObject({ status: 'SOLVED', solvedAt: NOW, contactedAt: NOW, reasonId: 3 });
    const reopened = applyEdit(aCase({ status: 'SOLVED', reasonId: 3, solvedAt: NOW, contactedAt: NOW }), { status: 'IN_PROGRESS' }, NOW);
    expect(reopened.solvedAt).toBeNull();
  });

  it('Cancelled needs a note saying why', () => {
    expect(code(() => applyEdit(aCase(), { status: 'CANCELLED' }, NOW))).toBe('case.cancelNote');
    expect(applyEdit(aCase(), { status: 'CANCELLED', notes: 'duplicate delivery' }, NOW).status).toBe('CANCELLED');
  });

  it('refuses Historical as a new status, dates before the rating or in the future, and solved before contacted', () => {
    expect(code(() => applyEdit(aCase(), { status: 'HISTORICAL' }, NOW))).toBe('case.status');
    expect(code(() => applyEdit(aCase(), { status: 'CONTACTED', contactedAt: '2026-10-15 08:59' }, NOW))).toBe('case.contactedAt');
    expect(code(() => applyEdit(aCase(), { status: 'CONTACTED', contactedAt: '2026-10-20 09:00' }, NOW))).toBe('case.contactedAt');
    expect(code(() => applyEdit(aCase(), { status: 'SOLVED', reasonId: 1, contactedAt: '2026-10-17 10:00', solvedAt: '2026-10-16 10:00' }, NOW)))
      .toBe('case.solvedAt');
    expect(applyEdit(aCase(), { status: 'CONTACTED', contactedAt: '2026-10-15T09:00' }, NOW).contactedAt).toBe('2026-10-15 09:00:00');
  });

  it('a Historical case is picked up by moving it to a follow-up status; its text fields stay editable', () => {
    expect(applyEdit(aCase({ status: 'HISTORICAL' }), { notes: 'old complaint' }, NOW)).toMatchObject({ status: 'HISTORICAL', notes: 'old complaint' });
    expect(applyEdit(aCase({ status: 'HISTORICAL' }), { status: 'NEW' }, NOW).status).toBe('NEW');
  });

  it('text is trimmed, empty becomes null, and long text is refused', () => {
    expect(applyEdit(aCase({ notes: 'a' }), { notes: '  ' }, NOW).notes).toBeNull();
    expect(code(() => applyEdit(aCase(), { rootCause: 'x'.repeat(2001) }, NOW))).toBe('case.rootCause');
  });

  it('the owner is free text: trimmed, spaces collapsed, empty clears it, at most 120 characters', () => {
    expect(applyEdit(aCase(), { owner: '  Branch   manager — Misrata ' }, NOW).ownerName).toBe('Branch manager — Misrata');
    expect(applyEdit(aCase({ ownerName: 'Ali' }), { owner: '' }, NOW).ownerName).toBeNull();
    expect(applyEdit(aCase({ ownerName: 'Ali' }), { notes: 'x' }, NOW).ownerName).toBe('Ali'); // untouched when not sent
    expect(code(() => applyEdit(aCase(), { owner: 'x'.repeat(121) }, NOW))).toBe('case.owner');
  });
});

describe('filters', () => {
  it('parses the follow-up filters and refuses bad values', () => {
    expect(parseFollowupQuery({ statuses: 'new,solved', reasonIds: '2', owners: '__none__, Ali Ahmed ', search: ' S28 ' })).toMatchObject({
      statuses: ['NEW', 'SOLVED'], reasonIds: [2], owners: ['__none__', 'Ali Ahmed'], search: 'S28', page: 1, pageSize: 100,
    });
    expect(() => parseFollowupQuery({ owners: 'x'.repeat(121) })).toThrow(/owners/);
    expect(() => parseFollowupQuery({ statuses: 'done' })).toThrow(/Unknown status/);
    expect(() => parseFollowupQuery({ dateFrom: '19/10/2026' })).toThrow(/date/);
    expect(() => parseFollowupQuery({ pageSize: '501' })).toThrow(/pageSize/);
  });

  it('builds parameterised SQL: global filters on the rating, own filters on the case, "no owner" as IS NULL', () => {
    const w = followupWhere(parseFollowupQuery({ dateFrom: '2026-10-01', dateTo: '2026-10-19', owners: '__none__,Ali Ahmed', statuses: 'NEW' }), { companyKeys: [1] });
    expect(w.sql).toContain('f.CompanyKey');
    expect(w.sql).toContain('c.rated_at_local >= ?');
    expect(w.sql).toContain('(c.owner_name IN (?) OR c.owner_name IS NULL)');
    expect(w.params).toEqual(expect.arrayContaining([1, '2026-10-01 00:00:00', '2026-10-19', 'NEW', 'Ali Ahmed']));
    expect(followupWhere({ search: '50%_' }, {}).params.slice(-4, -1)).toEqual(['%50\\%\\_%', '%50\\%\\_%', '%50\\%\\_%']);
  });
});

describe('change times', () => {
  it('UTC columns are shown in Tripoli time', async () => {
    const { utcToLocal } = await import('../npsFollowupService');
    expect(utcToLocal('2026-10-19 22:30:00')).toBe('2026-10-20 00:30:00');
    expect(utcToLocal(new Date('2026-10-19T08:00:00Z'))).toBe('2026-10-19 10:00:00');
    expect(utcToLocal(null)).toBeNull();
  });
});
