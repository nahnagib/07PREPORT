import { describe, expect, it } from 'vitest';
import {
  EMPTY_FILTERS,
  STAGES,
  STATUSES,
  apiQuery,
  byColumn,
  filtersFromSearch,
  filtersToSearch,
  formatHoursOpen,
  fromInput,
  groupReasons,
  historyValue,
  statusOfStage,
  toInput,
  type FollowupCase,
  type FollowupReason,
} from '../nps/followup';
import { editOf } from '../../components/nps-followup/CaseDetail';

const base = {
  stage: 'NEW', status: 'OPEN', reasonId: null, categoryKey: null, reasonNote: null, ownerUserId: null, ownerName: null, contactedAt: null,
  resolvedAt: null, rootCause: null, actionTaken: null, notes: null, version: 4,
} as unknown as FollowupCase;
const emptyForm = {
  stage: 'NEW' as const, category: '', reasonId: '', reasonNote: '', owner: '', contactedAt: '', resolvedAt: '', rootCause: '', actionTaken: '', notes: '',
};

describe('Detractor Follow-up view helpers', () => {
  it('time open reads in hours under two days, then in days', () => {
    expect(formatHoursOpen(null)).toBe('—');
    expect(formatHoursOpen(26.7)).toBe('26 h');
    expect(formatHoursOpen(47.9)).toBe('47 h');
    expect(formatHoursOpen(48)).toBe('2.0 d');
    expect(formatHoursOpen(130)).toBe('5.4 d');
  });

  it('stage and status are separate lists, and the status follows the stage', () => {
    expect([...STAGES]).toEqual(['HISTORICAL', 'NEW', 'CONTACTED', 'IN_PROGRESS', 'RESOLVED', 'REJECTED']);
    expect([...STATUSES]).toEqual(['OPEN', 'CLOSE', 'DISPUTED']);
    expect(STAGES.map(statusOfStage)).toEqual([null, 'OPEN', 'OPEN', 'OPEN', 'CLOSE', 'DISPUTED']);
  });

  it('filters round-trip through the URL; stage and status apart; defaults are left out', () => {
    expect(filtersToSearch(EMPTY_FILTERS)).toBe('');
    const f = {
      view: 'list' as const, dateFrom: '2026-10-01', stages: ['NEW' as const], statuses: ['OPEN' as const], categories: ['delivery'], reasonIds: [2],
      owners: ['__none__', 'Ali Ahmed'], sourceChanged: true, search: 'S28',
    };
    const q = filtersToSearch(f, 7);
    expect(filtersFromSearch(`?${q}`)).toEqual({ ...f, dateTo: undefined, caseId: 7 });
    // a value of the other list is dropped, never mixed in
    expect(filtersFromSearch('?stages=NEW,OPEN,SOLVED&statuses=CLOSE,RESOLVED&view=x')).toMatchObject({ stages: ['NEW'], statuses: ['CLOSE'] });
  });

  it('the API query carries the global filters and the follow-up filters, never the view', () => {
    const q = new URLSearchParams(apiQuery({ companyKeys: [1], salesTeamKeys: ['B2B'] },
      { ...EMPTY_FILTERS, view: 'list', stages: ['RESOLVED'], statuses: ['CLOSE'], categories: ['delivery'] }, { page: 2 }));
    expect(q.getAll('companyKeys')).toEqual(['1']);
    expect(q.get('salesTeamKeys')).toBe('B2B');
    expect(q.get('stages')).toBe('RESOLVED');
    expect(q.get('statuses')).toBe('CLOSE');
    expect(q.get('categories')).toBe('delivery');
    expect(q.get('page')).toBe('2');
    expect(q.has('view')).toBe(false);
  });

  it('groups the board by stage (the columns)', () => {
    const cases = [{ caseId: 1, stage: 'NEW', status: 'OPEN' }, { caseId: 2, stage: 'RESOLVED', status: 'CLOSE' }, { caseId: 3, stage: 'NEW', status: 'OPEN' }] as FollowupCase[];
    const cols = byColumn(cases);
    expect(cols.NEW.map((c) => c.caseId)).toEqual([1, 3]);
    expect(cols.RESOLVED).toHaveLength(1);
    expect(cols.REJECTED).toEqual([]);
  });

  it('groups the reasons as categories with their sub-reasons', () => {
    const r = (reasonId: number, categoryKey: string, subReasonEn: string | null, requiresNote = false) =>
      ({ reasonId, categoryKey, categoryEn: categoryKey, categoryAr: categoryKey, subReasonEn, subReasonAr: subReasonEn, requiresNote }) as FollowupReason;
    const groups = groupReasons([r(1, 'delivery', null), r(2, 'delivery', 'Late deliveries'), r(3, 'other', null, true), r(4, 'delivery', 'Damaged goods')]);
    expect(groups.map((g) => [g.categoryKey, g.row.reasonId, g.subReasons.map((s) => s.reasonId)])).toEqual([['delivery', 1, [2, 4]], ['other', 3, []]]);
  });

  it('date-time inputs and history values (the history records the stage)', () => {
    expect(toInput('2026-10-19 09:37:42')).toBe('2026-10-19T09:37');
    expect(fromInput('2026-10-19T09:37')).toBe('2026-10-19 09:37');
    expect(fromInput('')).toBeNull();
    expect(historyValue('stage', 'IN_PROGRESS')).toBe('In progress');
    expect(historyValue('stage', 'RESOLVED')).toBe('Resolved');
    expect(historyValue('resolved_at', '2026-10-19 09:37:00')).toBe('2026-10-19 09:37');
    expect(historyValue('notes', null)).toBe('—');
  });

  it('a save sends only the changed fields with the version it was made on, and never a status', () => {
    const form = { ...emptyForm, stage: 'CONTACTED' as const, category: 'delivery', reasonId: '3', notes: ' x ' };
    const edit = editOf(base, form);
    expect(edit).toEqual({ version: 4, stage: 'CONTACTED', reasonId: 3, notes: ' x ' });
    expect(edit).not.toHaveProperty('status');
  });

  it('the Other note is sent trimmed with its reason', () => {
    expect(editOf(base, { ...emptyForm, category: 'other', reasonId: '11', reasonNote: ' asked for a visit ' }))
      .toEqual({ version: 4, reasonId: 11, reasonNote: 'asked for a visit' });
  });

  it('the owner is typed text: sent trimmed when it changes, null when cleared, not sent when only spaces changed', () => {
    expect(editOf(base, { ...emptyForm, owner: '  Branch manager ' })).toEqual({ version: 4, owner: 'Branch manager' });
    expect(editOf({ ...base, ownerName: 'Ali' }, emptyForm)).toEqual({ version: 4, owner: null });
    expect(editOf({ ...base, ownerName: 'Ali' }, { ...emptyForm, owner: 'Ali ' })).toEqual({ version: 4 });
  });
});
