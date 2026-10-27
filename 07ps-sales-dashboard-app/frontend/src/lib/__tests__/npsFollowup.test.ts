import { describe, expect, it } from 'vitest';
import {
  EMPTY_FILTERS,
  apiQuery,
  byColumn,
  filtersFromSearch,
  filtersToSearch,
  formatHoursOpen,
  fromInput,
  historyValue,
  toInput,
  type FollowupCase,
} from '../nps/followup';
import { editOf } from '../../components/nps-followup/CaseDetail';

const base = { reasonId: null, ownerUserId: null, ownerName: null, contactedAt: null, solvedAt: null, rootCause: null, actionTaken: null, notes: null, version: 4 };

describe('Detractor Follow-up view helpers', () => {
  it('time open reads in hours under two days, then in days', () => {
    expect(formatHoursOpen(null)).toBe('—');
    expect(formatHoursOpen(26.7)).toBe('26 h');
    expect(formatHoursOpen(47.9)).toBe('47 h');
    expect(formatHoursOpen(48)).toBe('2.0 d');
    expect(formatHoursOpen(130)).toBe('5.4 d');
  });

  it('filters round-trip through the URL; defaults are left out', () => {
    expect(filtersToSearch(EMPTY_FILTERS)).toBe('');
    const f = { view: 'list' as const, dateFrom: '2026-10-01', statuses: ['NEW' as const], reasonIds: [2], owners: ['__none__', 'Ali Ahmed'], sourceChanged: true, search: 'S28' };
    const q = filtersToSearch(f, 7);
    expect(filtersFromSearch(`?${q}`)).toEqual({ ...f, dateTo: undefined, caseId: 7 });
    expect(filtersFromSearch('?statuses=NEW,BOGUS&view=x').statuses).toEqual(['NEW']);
  });

  it('the API query carries the global filters and the follow-up filters, never the view', () => {
    const q = new URLSearchParams(apiQuery({ companyKeys: [1], salesTeamKeys: ['B2B'] }, { ...EMPTY_FILTERS, view: 'list', statuses: ['SOLVED'] }, { page: 2 }));
    expect(q.getAll('companyKeys')).toEqual(['1']);
    expect(q.get('salesTeamKeys')).toBe('B2B');
    expect(q.get('statuses')).toBe('SOLVED');
    expect(q.get('page')).toBe('2');
    expect(q.has('view')).toBe(false);
  });

  it('groups the board by status', () => {
    const cases = [{ caseId: 1, status: 'NEW' }, { caseId: 2, status: 'SOLVED' }, { caseId: 3, status: 'NEW' }] as FollowupCase[];
    const cols = byColumn(cases);
    expect(cols.NEW.map((c) => c.caseId)).toEqual([1, 3]);
    expect(cols.SOLVED).toHaveLength(1);
    expect(cols.CANCELLED).toEqual([]);
  });

  it('date-time inputs and history values', () => {
    expect(toInput('2026-10-19 09:37:42')).toBe('2026-10-19T09:37');
    expect(fromInput('2026-10-19T09:37')).toBe('2026-10-19 09:37');
    expect(fromInput('')).toBeNull();
    expect(historyValue('status', 'IN_PROGRESS')).toBe('In progress');
    expect(historyValue('solved_at', '2026-10-19 09:37:00')).toBe('2026-10-19 09:37');
    expect(historyValue('notes', null)).toBe('—');
  });

  it('a save sends only the changed fields with the version it was made on', () => {
    const c = { ...base, status: 'NEW' } as FollowupCase;
    const form = { status: 'CONTACTED' as const, reasonId: '3', owner: '', contactedAt: '', solvedAt: '', rootCause: '', actionTaken: '', notes: ' x ' };
    expect(editOf(c, form)).toEqual({ version: 4, status: 'CONTACTED', reasonId: 3, notes: ' x ' });
  });

  it('the owner is typed text: sent trimmed when it changes, null when cleared, not sent when only spaces changed', () => {
    const form = { status: 'NEW' as const, reasonId: '', owner: '', contactedAt: '', solvedAt: '', rootCause: '', actionTaken: '', notes: '' };
    expect(editOf({ ...base, status: 'NEW' } as FollowupCase, { ...form, owner: '  Branch manager ' })).toEqual({ version: 4, owner: 'Branch manager' });
    expect(editOf({ ...base, status: 'NEW', ownerName: 'Ali' } as FollowupCase, form)).toEqual({ version: 4, owner: null });
    expect(editOf({ ...base, status: 'NEW', ownerName: 'Ali' } as FollowupCase, { ...form, owner: 'Ali ' })).toEqual({ version: 4 });
  });
});
