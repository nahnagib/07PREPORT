import { describe, expect, it } from 'vitest';
import {
  afterGateApproved, assertWeightsTotal100, checkCapacity, checkSubmit, computeKpis, evaluateDecision, fastTrackOverdue,
  gatePreconditionErrors, gatesWithoutApprovers, inFreeze, projectMix, quarterRange, scoreRound, weightedScore,
  type Criterion, type DecisionInput, type GateFacts, type KpiTarget, type SignoffRule,
} from '../rules';
import { SEED_CRITERIA, SEED_GATE_RULES, SEED_KPI_TARGETS } from '../seedConfig';
import { PdpError } from '../errors';

/** Every rule of docs/product-development-plan.md section 3, allowed and blocked, without a database. */

const CRITERIA: Criterion[] = SEED_CRITERIA.map((c, i) => ({ criterion_id: i + 1, name: c.name, weight: c.weight, meanings: [...c.meanings] }));
const entries = (scores: number[]) => scores.map((score, i) => ({ criterionId: i + 1, score, evidence: `evidence ${i + 1}` }));
const RULES: SignoffRule[] = SEED_GATE_RULES.map(([gate, code, label, roles, mode, appliesTo]) => ({ gate: gate as SignoffRule['gate'], code, label, roles, mode, appliesTo, active: true }));

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof PdpError ? e.code : `not a PdpError: ${String(e)}`;
  }
  return undefined;
}

// ------------------------------------------------------------------------------------------------ scoring

describe('scoring matrix maths (weighted = score x weight / 5, total out of 100, min 60)', () => {
  it('an all-5 round gives 100 and passes', () => {
    const r = scoreRound(CRITERIA, entries([5, 5, 5, 5, 5, 5]), 60);
    expect(r.total).toBe(100);
    expect(r.passed).toBe(true);
    expect(r.rows.map((x) => x.weighted)).toEqual([20, 20, 20, 20, 10, 10]);
  });
  it('an all-0 round gives 0 and is below 60', () => {
    const r = scoreRound(CRITERIA, entries([0, 0, 0, 0, 0, 0]), 60);
    expect(r.total).toBe(0);
    expect(r.passed).toBe(false);
  });
  it('4/3/2/5/1/0 = 16+12+8+20+2+0 = 58: BELOW 60', () => {
    const r = scoreRound(CRITERIA, entries([4, 3, 2, 5, 1, 0]), 60);
    expect(r.rows.map((x) => x.weighted)).toEqual([16, 12, 8, 20, 2, 0]);
    expect(r.total).toBe(58);
    expect(r.passed).toBe(false);
  });
  it('exactly 60 passes (all 3 = 12+12+12+12+6+6; also 5/5/5/0/0/0 = 60)', () => {
    expect(scoreRound(CRITERIA, entries([3, 3, 3, 3, 3, 3]), 60)).toMatchObject({ total: 60, passed: true });
    expect(scoreRound(CRITERIA, entries([5, 5, 5, 0, 0, 0]), 60)).toMatchObject({ total: 60, passed: true });
  });
  it('keeps the meaning text of the chosen score (the matrix nested IF)', () => {
    const r = scoreRound(CRITERIA, entries([5, 0, 0, 3, 1, 4]), 60);
    expect(r.rows.map((x) => x.meaning)).toEqual([
      'Critical strategic priority', 'No commercial value', 'Very high risk – likely to fail', 'Moderate difficulty', 'Low urgency', 'Low impact',
    ]);
  });
  it('a round must be complete: every criterion, whole score 0-5, evidence on each row', () => {
    expect(codeOf(() => scoreRound(CRITERIA, entries([5, 5, 5, 5, 5]), 60))).toBe('score.incomplete');
    expect(codeOf(() => scoreRound(CRITERIA, entries([5, 5, 5, 5, 5, 6]), 60))).toBe('score.range');
    expect(codeOf(() => scoreRound(CRITERIA, entries([5, 5, 5, 5, 5, 2.5]), 60))).toBe('score.range');
    expect(codeOf(() => scoreRound(CRITERIA, [...entries([5, 5, 5, 5, 5]), { criterionId: 6, score: 5, evidence: '  ' }], 60))).toBe('score.evidenceRequired');
    expect(codeOf(() => scoreRound(CRITERIA, [...entries([5, 5, 5, 5, 5, 5]), { criterionId: 1, score: 5, evidence: 'x' }], 60))).toBe('score.duplicate');
    expect(codeOf(() => scoreRound(CRITERIA, [...entries([5, 5, 5, 5, 5, 5]), { criterionId: 99, score: 5, evidence: 'x' }], 60))).toBe('score.unknownCriterion');
  });
  it('weights must total 100', () => {
    expect(weightedScore(3, 20)).toBe(12);
    expect(codeOf(() => assertWeightsTotal100([20, 20, 20, 20, 10, 10]))).toBeUndefined();
    expect(codeOf(() => assertWeightsTotal100([20, 20, 20, 20, 10, 5]))).toBe('criteria.weightTotal');
  });
});

// ------------------------------------------------------------------------------------------------ preconditions

const READY: GateFacts = {
  latestScore: { total: 72 }, minScore: 60, openChecklist: [], teamSize: 3, hasObjectives: true, hasTargetLaunchDate: true,
  labTests: 1, fieldTrialsWithTsLead: 1, confirmedBatches: 1,
};
const errs = (gate: Parameters<typeof gatePreconditionErrors>[0], f: Partial<GateFacts>) => gatePreconditionErrors(gate, { ...READY, ...f }).map((e) => e.code);

describe('gate data rules', () => {
  it('G1: complete scoring round, all feasibility items, score >= min, team, objectives, target date', () => {
    expect(errs('G1', {})).toEqual([]);
    expect(errs('G1', { latestScore: null })).toEqual(['gate.scoreMissing']);
    expect(errs('G1', { latestScore: { total: 58 } })).toEqual(['gate.scoreBelowMin']);
    expect(errs('G1', { latestScore: { total: 60 } })).toEqual([]);
    expect(errs('G1', { openChecklist: ['Market availability'] })).toEqual(['gate.checklistOpen']);
    expect(errs('G1', { teamSize: 0 })).toEqual(['gate.teamRequired']);
    expect(errs('G1', { hasObjectives: false })).toEqual(['gate.objectivesRequired']);
    expect(errs('G1', { hasTargetLaunchDate: false })).toEqual(['gate.targetDateRequired']);
  });
  it('G2 needs a lab test; G3 a field trial led by TS; G4 a confirmed 500-1500 kg batch; G5 the documentation package', () => {
    expect(errs('G2', { labTests: 0 })).toEqual(['gate.labTestRequired']);
    expect(errs('G3', { fieldTrialsWithTsLead: 0 })).toEqual(['gate.fieldTrialRequired']);
    expect(errs('G4', { confirmedBatches: 0 })).toEqual(['gate.pilotRequired']);
    expect(errs('G4', { openChecklist: ['Purity'] })).toEqual(['gate.checklistOpen']);
    expect(errs('G5', { openChecklist: ['TDS (Technical Data Sheet)'] })).toEqual(['gate.checklistOpen']);
    expect(errs('G5', {})).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------ decisions

function decision(over: Partial<DecisionInput> & { gate?: DecisionInput['project']['currentGate']; classification?: DecisionInput['project']['classification'] }) {
  const gate = over.gate ?? 'G1';
  const base: DecisionInput = {
    project: { state: gate === 'G1' ? 'submitted' : 'active', currentGate: gate, gateRound: 1, classification: over.classification ?? 'planned' },
    decision: 'approve', roleCode: 'CEO', comment: '', userRoles: ['CEO'], rules: RULES, prior: [], facts: READY, capacity: { active: 2, max: 6 }, userId: 7,
  };
  return { ...base, ...over, project: { ...base.project, ...(over.project ?? {}) } };
}

describe('gate decisions', () => {
  it('G1 kick-off: one Chairman or CEO approval completes it; the project becomes active at G2', () => {
    expect(evaluateDecision(decision({}))).toMatchObject({ gate: 'G1', completesGate: true, capacityOverride: false });
    expect(evaluateDecision(decision({ roleCode: 'CHAIRMAN', userRoles: ['CHAIRMAN'] }))).toMatchObject({ completesGate: true });
    expect(afterGateApproved('G1')).toEqual({ currentGate: 'G2', state: 'active' });
  });
  it('holding the approval permission is not enough: the governance role is required, and it must be one the gate needs', () => {
    expect(codeOf(() => evaluateDecision(decision({ roleCode: 'CEO', userRoles: [] })))).toBe('decision.notMember');
    expect(codeOf(() => evaluateDecision(decision({ roleCode: 'QC_QA', userRoles: ['QC_QA'] })))).toBe('decision.roleNotRequired');
  });
  it('below 60 only reject or revise are possible', () => {
    const low = { facts: { ...READY, latestScore: { total: 58 } } };
    expect(codeOf(() => evaluateDecision(decision(low)))).toBe('gate.scoreBelowMin');
    expect(evaluateDecision(decision({ ...low, decision: 'reject', comment: 'not viable' }))).toMatchObject({ decision: 'reject' });
    expect(evaluateDecision(decision({ ...low, decision: 'revise', comment: 'rework the cost' }))).toMatchObject({ decision: 'revise' });
  });
  it('revise and reject need a comment', () => {
    expect(codeOf(() => evaluateDecision(decision({ decision: 'revise' })))).toBe('decision.commentRequired');
    expect(codeOf(() => evaluateDecision(decision({ decision: 'reject' })))).toBe('decision.commentRequired');
  });
  it('unplanned: the kick-off also needs a CEO or EXCO approval (a Chairman alone is not enough)', () => {
    const chair = evaluateDecision(decision({ classification: 'unplanned', roleCode: 'CHAIRMAN', userRoles: ['CHAIRMAN'] }));
    expect(chair.completesGate).toBe(false);
    const prior = [{ gate: 'G1', round: 1, decision: 'approve' as const, roleCode: 'CHAIRMAN', userId: 3 }];
    expect(evaluateDecision(decision({ classification: 'unplanned', roleCode: 'EXCO', userRoles: ['EXCO'], prior })).completesGate).toBe(true);
    // a CEO satisfies both sign-offs at once
    expect(evaluateDecision(decision({ classification: 'unplanned' })).completesGate).toBe(true);
  });
  it('G2 technical evaluation needs R&D AND QC/QA AND Production', () => {
    const g2 = (roleCode: string, prior: DecisionInput['prior'] = []) => evaluateDecision(decision({ gate: 'G2', roleCode, userRoles: [roleCode], prior }));
    expect(g2('RND').completesGate).toBe(false);
    const two = [{ gate: 'G2', round: 1, decision: 'approve' as const, roleCode: 'RND', userId: 1 }, { gate: 'G2', round: 1, decision: 'approve' as const, roleCode: 'QC_QA', userId: 2 }];
    expect(g2('PRODUCTION', two).completesGate).toBe(true);
    expect(codeOf(() => g2('RND', two))).toBe('decision.duplicate');
  });
  it('G3 = Technical Support, G4 = Technical Manager, G5 = EXCO; G5 launches', () => {
    expect(evaluateDecision(decision({ gate: 'G3', roleCode: 'TS', userRoles: ['TS'] })).completesGate).toBe(true);
    expect(evaluateDecision(decision({ gate: 'G4', roleCode: 'TECH_MANAGER', userRoles: ['TECH_MANAGER'] })).completesGate).toBe(true);
    expect(codeOf(() => evaluateDecision(decision({ gate: 'G5', roleCode: 'CEO', userRoles: ['CEO'] })))).toBe('decision.roleNotRequired');
    expect(evaluateDecision(decision({ gate: 'G5', roleCode: 'EXCO', userRoles: ['EXCO'] })).completesGate).toBe(true);
    expect(afterGateApproved('G5')).toEqual({ currentGate: 'G5', state: 'launched' });
  });
  it('each gate checks its own data before any approval', () => {
    expect(codeOf(() => evaluateDecision(decision({ gate: 'G2', roleCode: 'RND', userRoles: ['RND'], facts: { ...READY, labTests: 0 } })))).toBe('gate.labTestRequired');
    expect(codeOf(() => evaluateDecision(decision({ gate: 'G4', roleCode: 'TECH_MANAGER', userRoles: ['TECH_MANAGER'], facts: { ...READY, confirmedBatches: 0 } })))).toBe('gate.pilotRequired');
  });
  it('decisions only on an open gate: not on a draft, on hold, rejected, launched or closed project', () => {
    expect(codeOf(() => evaluateDecision(decision({ project: { state: 'draft', currentGate: 'G0', gateRound: 1, classification: 'planned' } })))).toBe('project.notSubmitted');
    expect(codeOf(() => evaluateDecision(decision({ project: { state: 'on_hold', currentGate: 'G3', gateRound: 1, classification: 'planned' } })))).toBe('project.onHold');
    for (const state of ['rejected', 'launched', 'closed'] as const) {
      expect(codeOf(() => evaluateDecision(decision({ project: { state, currentGate: 'G5', gateRound: 1, classification: 'planned' } })))).toBe('project.readOnly');
    }
  });
  it('gates are sequential: a G3 approver cannot act while the project is at G2', () => {
    expect(codeOf(() => evaluateDecision(decision({ gate: 'G2', roleCode: 'TS', userRoles: ['TS'] })))).toBe('decision.roleNotRequired');
  });
  it('approvals from an earlier round (before a revise) do not count', () => {
    const old = [{ gate: 'G2', round: 1, decision: 'approve' as const, roleCode: 'RND', userId: 1 }];
    // the caller passes only the current round's decisions; round 2 starts empty, so RND may approve again
    expect(evaluateDecision(decision({ gate: 'G2', roleCode: 'RND', userRoles: ['RND'], project: { state: 'active', currentGate: 'G2', gateRound: 2, classification: 'planned' }, prior: old.filter((d) => d.round === 2) })).completesGate).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------ capacity / freeze

describe('capacity (max 6 active projects)', () => {
  it('within the cap: no override', () => {
    expect(checkCapacity({ active: 5, max: 6 }, ['CHAIRMAN'], undefined)).toBe(false);
  });
  it('over the cap: blocked for everyone except CEO/EXCO, who must give a reason', () => {
    expect(codeOf(() => checkCapacity({ active: 6, max: 6 }, ['CHAIRMAN'], 'x'))).toBe('capacity.full');
    expect(codeOf(() => checkCapacity({ active: 6, max: 6 }, ['CEO'], ''))).toBe('capacity.reasonRequired');
    expect(checkCapacity({ active: 6, max: 6 }, ['EXCO'], 'customer contract')).toBe(true);
  });
  it('the G1 approval that would exceed the cap is checked at completion', () => {
    expect(codeOf(() => evaluateDecision(decision({ roleCode: 'CHAIRMAN', userRoles: ['CHAIRMAN'], capacity: { active: 6, max: 6 } })))).toBe('capacity.full');
    expect(evaluateDecision(decision({ capacity: { active: 6, max: 6 }, overrideReason: 'urgent tender' }))).toMatchObject({ completesGate: true, capacityOverride: true });
  });
  it('the 50/30/20 mix is a warning only', () => {
    const m = projectMix(['planned', 'unplanned', 'unplanned', 'unplanned'], { planned: 50, unplanned: 30, innovation: 20 });
    expect(m.rows.map((r) => [r.classification, r.count, r.pct])).toEqual([['planned', 1, 25], ['unplanned', 3, 75], ['innovation', 0, 0]]);
    expect(m.warning).toBe(true);
  });
});

describe('peak-season freeze and submission (G0 -> G1)', () => {
  it('no freeze when the months are empty (the 2026-11-14 setting)', () => {
    expect(inFreeze('2026-07-01', '', '')).toBe(false);
  });
  it('ranges, including one that wraps the year', () => {
    expect(inFreeze('2026-07-01', '06-01', '08-31')).toBe(true);
    expect(inFreeze('2026-09-01', '06-01', '08-31')).toBe(false);
    expect(inFreeze('2026-01-10', '11-15', '02-15')).toBe(true);
    expect(inFreeze('2026-03-01', '11-15', '02-15')).toBe(false);
  });
  const p = { state: 'draft' as const, hasTreeLink: true, classification: 'planned' as const };
  it('submitting is enough outside the freeze; never without a Product Tree link; never twice', () => {
    expect(checkSubmit(p, false, [], undefined)).toEqual({ freezeOverride: false });
    expect(codeOf(() => checkSubmit({ ...p, hasTreeLink: false }, false, [], undefined))).toBe('project.treeLink');
    expect(codeOf(() => checkSubmit({ ...p, state: 'submitted' }, false, [], undefined))).toBe('project.alreadySubmitted');
  });
  it('inside the freeze: only unplanned, by a CEO/EXCO, with a reason', () => {
    expect(codeOf(() => checkSubmit(p, true, ['CEO'], 'x'))).toBe('freeze.active');
    expect(codeOf(() => checkSubmit({ ...p, classification: 'unplanned' }, true, ['RND'], 'x'))).toBe('freeze.needsExec');
    expect(codeOf(() => checkSubmit({ ...p, classification: 'unplanned' }, true, ['EXCO'], ''))).toBe('freeze.reasonRequired');
    expect(checkSubmit({ ...p, classification: 'unplanned' }, true, ['EXCO'], 'client emergency')).toEqual({ freezeOverride: true });
  });
});

describe('fast-track 72-hour feasibility clock', () => {
  const p = { fastTrack: true, submittedAt: '2026-11-10T08:00:00.000Z', currentGate: 'G1' as const, state: 'submitted' as const };
  it('alerts after 72 h without feasibility, not before, not once it is done, not without fast-track', () => {
    expect(fastTrackOverdue(p, false, 72, new Date('2026-11-13T08:00:01Z'))).toBe(true);
    expect(fastTrackOverdue(p, false, 72, new Date('2026-11-13T07:59:59Z'))).toBe(false);
    expect(fastTrackOverdue(p, true, 72, new Date('2026-11-20T00:00:00Z'))).toBe(false);
    expect(fastTrackOverdue({ ...p, fastTrack: false }, false, 72, new Date('2026-11-20T00:00:00Z'))).toBe(false);
  });
});

describe('No approver assigned for G_', () => {
  it('flags gates whose sign-off roles have nobody (ALL: every role, ANY: at least one)', () => {
    expect(gatesWithoutApprovers(RULES, {})).toEqual(['G1', 'G2', 'G3', 'G4', 'G5']);
    const most = { CEO: 1, RND: 1, QC_QA: 1, TS: 1, TECH_MANAGER: 1, EXCO: 1 };
    expect(gatesWithoutApprovers(RULES, most)).toEqual(['G2']); // Production missing
    expect(gatesWithoutApprovers(RULES, { ...most, PRODUCTION: 1 })).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------ KPIs

const TARGETS: KpiTarget[] = SEED_KPI_TARGETS.map(([kpi_code, label, target, comparator, unit]) => ({ kpi_code, label, target, comparator, unit }));

describe('KPI formulas (one fixture, 2026-Q4)', () => {
  const { from, to } = quarterRange('2026-Q4');
  const tiles = computeKpis({
    launches: [
      { projectId: 1, classification: 'planned', launchedAt: '2026-10-20', submittedAt: '2026-09-01', targetLaunchDate: '2026-10-31' }, // 49 d, on time
      { projectId: 2, classification: 'innovation', launchedAt: '2026-11-05', submittedAt: '2026-08-07', targetLaunchDate: '2026-10-31' }, // 90 d, late
      { projectId: 3, classification: 'reformulation', launchedAt: '2026-12-01', submittedAt: '2026-10-02', targetLaunchDate: null }, // 60 d, no target = late
      { projectId: 4, classification: 'planned', launchedAt: '2026-09-30', submittedAt: '2026-08-01', targetLaunchDate: '2026-12-31' }, // Q3: outside
    ],
    fieldTrials: [
      { projectId: 1, date: '2026-10-01', passed: true }, { projectId: 1, date: '2026-10-08', passed: true },
      { projectId: 2, date: '2026-10-09', passed: true }, { projectId: 2, date: '2026-11-01', passed: false },
      { projectId: 5, date: '2026-09-01', passed: false }, // Q3: outside
    ],
    labTests: [
      { projectId: 1, trialNo: 1, date: '2026-10-02', passed: true }, { projectId: 1, trialNo: 1, date: '2026-10-02', passed: true },
      { projectId: 2, trialNo: 1, date: '2026-10-03', passed: true }, { projectId: 2, trialNo: 1, date: '2026-10-03', passed: false },
      { projectId: 2, trialNo: 2, date: '2026-10-10', passed: true }, // a later trial does not rescue the first pass
      { projectId: 3, trialNo: 1, date: '2026-09-20', passed: true }, // first trial in Q3: outside
    ],
    docErrors: [
      { projectId: 1, severity: 'minor', foundDate: '2026-10-05' }, { projectId: 2, severity: 'critical', foundDate: '2026-11-02' },
      { projectId: 3, severity: 'critical', foundDate: '2026-08-02' },
    ],
  }, TARGETS, from, to);
  const t = Object.fromEntries(tiles.map((x) => [x.code, x]));

  it('quarter range', () => {
    expect(quarterRange('2026-Q4')).toEqual({ from: '2026-10-01', to: '2026-12-31' });
    expect(quarterRange('2024-Q1')).toEqual({ from: '2024-01-01', to: '2024-03-31' });
  });
  it('new products = G5 approvals that are not reformulations (2 < 3: red); reformulations = 1 (< 2: red)', () => {
    expect(t.NEW_PRODUCTS).toMatchObject({ value: 2, status: 'red', projectIds: [1, 2] });
    expect(t.REFORMULATIONS).toMatchObject({ value: 1, status: 'red', projectIds: [3] });
  });
  it('field-trial success = passed / all trials in the period: 3/4 = 75% (< 80: red)', () => {
    expect(t.FIELD_TRIAL_SUCCESS).toMatchObject({ value: 75, numerator: 3, denominator: 4, status: 'red' });
  });
  it('first-pass lab success = projects whose trial 1 passed every target: 1/2 = 50%', () => {
    expect(t.FIRST_PASS_LAB).toMatchObject({ value: 50, numerator: 1, denominator: 2, status: 'red' });
  });
  it('on-time = launched on/before target: 1/3 = 33.3%', () => {
    expect(t.ON_TIME).toMatchObject({ value: 33.3, numerator: 1, denominator: 3, status: 'red' });
  });
  it('cycle time = average days G0 submission -> G5 approval: (49 + 90 + 60) / 3 = 66.3 (> 60: red)', () => {
    expect(t.CYCLE_TIME).toMatchObject({ value: 66.3, status: 'red' });
  });
  it('critical documentation errors in the period: 1 (> 0: red); minor ones do not count', () => {
    expect(t.CRITICAL_DOC_ERRORS).toMatchObject({ value: 1, status: 'red' });
  });
  it('an empty quarter: counts are 0 (green only where 0 meets the target), rates have no data', () => {
    const empty = Object.fromEntries(computeKpis({ launches: [], fieldTrials: [], labTests: [], docErrors: [] }, TARGETS, from, to).map((x) => [x.code, x]));
    expect(empty.NEW_PRODUCTS).toMatchObject({ value: 0, status: 'red' });
    expect(empty.CRITICAL_DOC_ERRORS).toMatchObject({ value: 0, status: 'green' });
    expect(empty.FIELD_TRIAL_SUCCESS).toMatchObject({ value: null, status: 'none' });
    expect(empty.CYCLE_TIME).toMatchObject({ value: null, status: 'none' });
  });
  it('green when the target is met', () => {
    const good = Object.fromEntries(computeKpis({
      launches: [1, 2, 3].map((i) => ({ projectId: i, classification: 'planned' as const, launchedAt: '2026-10-10', submittedAt: '2026-09-10', targetLaunchDate: '2026-10-10' })),
      fieldTrials: [{ projectId: 1, date: '2026-10-01', passed: true }], labTests: [{ projectId: 1, trialNo: 1, date: '2026-10-01', passed: true }], docErrors: [],
    }, TARGETS, from, to).map((x) => [x.code, x]));
    expect(['NEW_PRODUCTS', 'FIELD_TRIAL_SUCCESS', 'FIRST_PASS_LAB', 'ON_TIME', 'CYCLE_TIME', 'CRITICAL_DOC_ERRORS'].map((c) => good[c].status)).toEqual(Array(6).fill('green'));
  });
});
