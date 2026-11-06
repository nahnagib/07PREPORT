import { describe, expect, it } from 'vitest';
import {
  FollowupValidationError,
  applyEdit,
  followupWhere,
  hoursOpen,
  nowLocal,
  parseFollowupQuery,
  reasonLabel,
  slugOf,
  statusOfStage,
  timeBand,
  type FollowupCase,
} from '../npsFollowupService';

const NOW = '2026-10-19 12:00:00';

function aCase(over: Partial<FollowupCase> = {}): FollowupCase {
  return {
    caseId: 1, responseId: 10, ratedAt: '2026-10-15 09:00:00', stage: 'NEW', status: 'OPEN', reasonId: null, categoryKey: null,
    categoryEn: null, categoryAr: null, subReasonEn: null, subReasonAr: null, reasonLabelEn: null, reasonLabelAr: null, reasonNote: null,
    ownerUserId: null, ownerName: null, contactedAt: null, resolvedAt: null, rejectedAt: null, rootCause: null, actionTaken: null, notes: null,
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

  it('runs to now in an open stage, to the resolved time once resolved, and not at all for rejected or historical cases', () => {
    expect(hoursOpen(aCase(), NOW)).toBe(99);
    expect(hoursOpen(aCase({ stage: 'RESOLVED', status: 'CLOSE', resolvedAt: '2026-10-16 10:00:00' }), NOW)).toBe(25);
    expect(hoursOpen(aCase({ stage: 'REJECTED', status: 'DISPUTED' }), NOW)).toBeNull();
    expect(hoursOpen(aCase({ stage: 'HISTORICAL', status: null }), NOW)).toBeNull();
  });

  it('now is the Tripoli wall clock (UTC+2), not the server zone', () => {
    expect(nowLocal(new Date('2026-10-19T22:30:00Z'))).toBe('2026-10-20 00:30:00');
  });
});

describe('stage and status', () => {
  it('the status is worked out from the stage, exactly like the generated column of migration 0066', () => {
    expect((['NEW', 'CONTACTED', 'IN_PROGRESS'] as const).map((s) => statusOfStage(s))).toEqual(['OPEN', 'OPEN', 'OPEN']);
    expect(statusOfStage('RESOLVED')).toBe('CLOSE');
    expect(statusOfStage('REJECTED')).toBe('DISPUTED');
    expect(statusOfStage('HISTORICAL')).toBeNull();
  });

  it('a client can never write the status (or rejected_at): the edit is refused, whatever the value', () => {
    expect(code(() => applyEdit(aCase(), { status: 'CLOSE' }, NOW))).toBe('case.statusReadOnly');
    expect(code(() => applyEdit(aCase(), { status: 'RESOLVED' }, NOW))).toBe('case.statusReadOnly');
    expect(code(() => applyEdit(aCase(), { stage: 'CONTACTED', status: 'OPEN' }, NOW))).toBe('case.statusReadOnly');
    expect(code(() => applyEdit(aCase(), { rejectedAt: NOW }, NOW))).toBe('case.rejectedAtReadOnly');
  });

  it('the edit result has no status field, so it can never be written or audited', () => {
    expect(Object.keys(applyEdit(aCase(), { stage: 'CONTACTED' }, NOW))).not.toContain('status');
  });

  it('a status value is not a stage, and a stage value is not a status', () => {
    expect(code(() => applyEdit(aCase(), { stage: 'OPEN' }, NOW))).toBe('case.stage');
    expect(code(() => applyEdit(aCase(), { stage: 'SOLVED' }, NOW))).toBe('case.stage');
    expect(code(() => applyEdit(aCase(), { stage: 'CANCELLED' }, NOW))).toBe('case.stage');
    expect(() => parseFollowupQuery({ statuses: 'NEW' })).toThrow(/Unknown status NEW/);
    expect(() => parseFollowupQuery({ stages: 'OPEN' })).toThrow(/Unknown stage OPEN/);
  });
});

describe('editing a case', () => {
  it('Contacted fills the contact time with now when empty', () => {
    expect(applyEdit(aCase(), { stage: 'CONTACTED' }, NOW)).toMatchObject({ stage: 'CONTACTED', contactedAt: NOW, resolvedAt: null });
  });

  it('Resolved needs a reason, fills the resolved time, and leaving Resolved clears it', () => {
    expect(code(() => applyEdit(aCase(), { stage: 'RESOLVED' }, NOW))).toBe('case.reasonRequired');
    const resolved = applyEdit(aCase(), { stage: 'RESOLVED', reasonId: 3 }, NOW);
    expect(resolved).toMatchObject({ stage: 'RESOLVED', resolvedAt: NOW, contactedAt: NOW, reasonId: 3 });
    const reopened = applyEdit(aCase({ stage: 'RESOLVED', status: 'CLOSE', reasonId: 3, resolvedAt: NOW, contactedAt: NOW }), { stage: 'IN_PROGRESS' }, NOW);
    expect(reopened.resolvedAt).toBeNull();
  });

  it('Rejected needs a note saying why and records when it was rejected; leaving Rejected clears that time', () => {
    expect(code(() => applyEdit(aCase(), { stage: 'REJECTED' }, NOW))).toBe('case.rejectNote');
    expect(applyEdit(aCase(), { stage: 'REJECTED', notes: 'duplicate delivery' }, NOW)).toMatchObject({ stage: 'REJECTED', rejectedAt: NOW });
    const rejected = aCase({ stage: 'REJECTED', status: 'DISPUTED', notes: 'dup', rejectedAt: '2026-10-16 08:00:00' });
    expect(applyEdit(rejected, { notes: 'duplicate' }, NOW).rejectedAt).toBe('2026-10-16 08:00:00'); // kept while it stays Rejected
    expect(applyEdit(rejected, { stage: 'IN_PROGRESS' }, NOW).rejectedAt).toBeNull();
  });

  it('refuses Historical as a new stage, dates before the rating or in the future, and resolved before contacted', () => {
    expect(code(() => applyEdit(aCase(), { stage: 'HISTORICAL' }, NOW))).toBe('case.stage');
    expect(code(() => applyEdit(aCase(), { stage: 'CONTACTED', contactedAt: '2026-10-15 08:59' }, NOW))).toBe('case.contactedAt');
    expect(code(() => applyEdit(aCase(), { stage: 'CONTACTED', contactedAt: '2026-10-20 09:00' }, NOW))).toBe('case.contactedAt');
    expect(code(() => applyEdit(aCase(), { stage: 'RESOLVED', reasonId: 1, contactedAt: '2026-10-17 10:00', resolvedAt: '2026-10-16 10:00' }, NOW)))
      .toBe('case.resolvedAt');
    expect(applyEdit(aCase(), { stage: 'CONTACTED', contactedAt: '2026-10-15T09:00' }, NOW).contactedAt).toBe('2026-10-15 09:00:00');
  });

  it('a Historical case is picked up by moving it to a follow-up stage; its text fields stay editable', () => {
    const hist = aCase({ stage: 'HISTORICAL', status: null });
    expect(applyEdit(hist, { notes: 'old complaint' }, NOW)).toMatchObject({ stage: 'HISTORICAL', notes: 'old complaint' });
    expect(applyEdit(hist, { stage: 'NEW' }, NOW).stage).toBe('NEW');
  });

  it('the "Other" reason needs a short note; the note goes when the reason is no longer Other', () => {
    const other = { requiresNote: true };
    expect(code(() => applyEdit(aCase(), { reasonId: 11 }, NOW, other))).toBe('case.reasonNote');
    expect(applyEdit(aCase(), { reasonId: 11, reasonNote: ' asked for a visit ' }, NOW, other).reasonNote).toBe('asked for a visit');
    expect(code(() => applyEdit(aCase(), { reasonId: 11, reasonNote: 'x'.repeat(201) }, NOW, other))).toBe('case.reasonNote');
    expect(applyEdit(aCase({ reasonId: 11, reasonNote: 'visit' }), { reasonId: 5 }, NOW, { requiresNote: false }).reasonNote).toBeNull();
    // a case moved to Other by migration 0067 (no note) can still be edited without adding one
    expect(applyEdit(aCase({ reasonId: 11 }), { stage: 'CONTACTED' }, NOW, other).stage).toBe('CONTACTED');
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

describe('reasons', () => {
  it('reads as one line: category › sub-reason, category › Not specified, or just Other', () => {
    expect(reasonLabel('Delivery & Logistics', 'Late deliveries', false)).toBe('Delivery & Logistics › Late deliveries');
    expect(reasonLabel('Delivery & Logistics', null, false)).toBe('Delivery & Logistics › Not specified');
    expect(reasonLabel('Other', null, true)).toBe('Other');
    expect(reasonLabel(null, null, false)).toBeNull();
  });

  it('new keys are slugs of the English name', () => {
    expect(slugOf('Late deliveries')).toBe('late_deliveries');
    expect(slugOf('Claims & After-Sales')).toBe('claims_after_sales');
    expect(slugOf('عربي')).toBe('reason');
  });
});

describe('filters', () => {
  it('parses the follow-up filters and refuses bad values', () => {
    expect(parseFollowupQuery({ stages: 'new,resolved', statuses: 'open', categories: 'Delivery', reasonIds: '2', owners: '__none__, Ali Ahmed ', search: ' S28 ' })).toMatchObject({
      stages: ['NEW', 'RESOLVED'], statuses: ['OPEN'], categories: ['delivery'], reasonIds: [2], owners: ['__none__', 'Ali Ahmed'], search: 'S28', page: 1, pageSize: 100,
    });
    expect(() => parseFollowupQuery({ categories: 'a b' })).toThrow(/categories/);
    expect(() => parseFollowupQuery({ owners: 'x'.repeat(121) })).toThrow(/owners/);
    expect(() => parseFollowupQuery({ statuses: 'done' })).toThrow(/Unknown status/);
    expect(() => parseFollowupQuery({ stages: 'SOLVED' })).toThrow(/Unknown stage/);
    expect(() => parseFollowupQuery({ dateFrom: '19/10/2026' })).toThrow(/date/);
    expect(() => parseFollowupQuery({ pageSize: '501' })).toThrow(/pageSize/);
  });

  it('builds parameterised SQL: global filters on the rating, stage and status apart, "no owner" as IS NULL', () => {
    const q = parseFollowupQuery({ dateFrom: '2026-10-01', dateTo: '2026-10-19', owners: '__none__,Ali Ahmed', stages: 'NEW', statuses: 'CLOSE', categories: 'delivery' });
    const w = followupWhere(q, { companyKeys: [1] });
    expect(w.sql).toContain('f.CompanyKey');
    expect(w.sql).toContain('c.rated_at_local >= ?');
    expect(w.sql).toContain('c.stage IN (?)');
    expect(w.sql).toContain('c.status IN (?)');
    expect(w.sql).toContain('r.category_key IN (?)');
    expect(w.sql).toContain('(c.owner_name IN (?) OR c.owner_name IS NULL)');
    expect(w.params).toEqual(expect.arrayContaining([1, '2026-10-01 00:00:00', '2026-10-19', 'NEW', 'CLOSE', 'delivery', 'Ali Ahmed']));
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
