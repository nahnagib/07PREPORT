import { PdpError } from './errors';

/**
 * Product Development Plan business rules, free of any database access so every rule can be tested on its own
 * (services/pdp/__tests__/rules.test.ts). The services load the facts, call these, and write the outcome.
 * Policy: TIKA R&D Policy v1.0 + Xtreme roadmap deck; workflow: docs/product-development-plan.md section 3.
 */

export const GATES = ['G0', 'G1', 'G2', 'G3', 'G4', 'G5'] as const;
export type Gate = (typeof GATES)[number];
export type DecisionGate = Exclude<Gate, 'G0'>;
export const STATES = ['draft', 'submitted', 'active', 'on_hold', 'rejected', 'launched', 'closed'] as const;
export type ProjectState = (typeof STATES)[number];
export const CLASSIFICATIONS = ['planned', 'unplanned', 'innovation', 'reformulation'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];
export const INNOVATION_CATEGORIES = ['quick_win', 'commercial_driven', 'technical_enhancement', 'strategic_long_term'] as const;
export type Decision = 'approve' | 'reject' | 'revise';
export const DECISIONS: Decision[] = ['approve', 'reject', 'revise'];
export const PRODUCT_STATUSES = ['in_market', 'planned', 'under_development', 'discontinued'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

/** Governance roles that may override the project cap and the peak-season freeze. */
export const EXEC_ROLES = ['CEO', 'EXCO'];

export function nextGate(g: Gate): Gate | null {
  const i = GATES.indexOf(g);
  return i >= 0 && i < GATES.length - 1 ? GATES[i + 1] : null;
}

// ------------------------------------------------------------------------------------------------ scoring

export interface Criterion {
  criterion_id: number;
  name: string;
  weight: number;
  meanings: string[]; // index 0..5
}
export interface ScoreEntry {
  criterionId: number;
  score: unknown;
  evidence: unknown;
}
export interface ScoredRow {
  criterion_id: number;
  criterion_name: string;
  weight: number;
  score: number;
  weighted: number;
  meaning: string;
  evidence: string;
}

/** weighted = score x weight / 5 (the matrix's own formula), 2 decimals. */
export function weightedScore(score: number, weight: number): number {
  return Math.round(((score * weight) / 5) * 100) / 100;
}

/** Active weights must add up to exactly 100 (the matrix is "out of 100"). */
export function assertWeightsTotal100(weights: number[]): void {
  const total = weights.reduce((s, w) => s + w, 0);
  if (total !== 100) throw new PdpError('criteria.weightTotal', `The active weights add up to ${total}; they must total 100.`, 'weight');
}

/**
 * A complete scoring round: every active criterion exactly once, a whole score 0-5 and evidence for each.
 * passed = total >= minScore (60 by default; exactly 60 passes).
 */
export function scoreRound(criteria: Criterion[], entries: ScoreEntry[], minScore: number): { rows: ScoredRow[]; total: number; passed: boolean } {
  if (criteria.length === 0) throw new PdpError('score.noCriteria', 'No active scoring criteria are configured.');
  const byId = new Map<number, ScoreEntry>();
  for (const e of entries) {
    const id = Number(e.criterionId);
    if (!criteria.some((c) => c.criterion_id === id)) throw new PdpError('score.unknownCriterion', 'Unknown scoring criterion.', 'scores');
    if (byId.has(id)) throw new PdpError('score.duplicate', 'A criterion is scored twice.', 'scores');
    byId.set(id, e);
  }
  const rows = criteria.map((c) => {
    const e = byId.get(c.criterion_id);
    if (!e) throw new PdpError('score.incomplete', `"${c.name}" is not scored: every criterion needs a score.`, `score.${c.criterion_id}`);
    const score = Number(e.score);
    if (e.score === null || e.score === '' || !Number.isInteger(score) || score < 0 || score > 5) {
      throw new PdpError('score.range', `The score for "${c.name}" must be a whole number from 0 to 5.`, `score.${c.criterion_id}`);
    }
    const evidence = typeof e.evidence === 'string' ? e.evidence.trim() : '';
    if (!evidence) throw new PdpError('score.evidenceRequired', `Evidence is required for "${c.name}".`, `evidence.${c.criterion_id}`);
    return { criterion_id: c.criterion_id, criterion_name: c.name, weight: c.weight, score, weighted: weightedScore(score, c.weight), meaning: c.meanings[score] ?? '', evidence };
  });
  const total = Math.round(rows.reduce((s, r) => s + r.weighted, 0) * 100) / 100;
  return { rows, total, passed: total >= minScore };
}

// ------------------------------------------------------------------------------------------------ gate sign-offs

export interface SignoffRule {
  code: string;
  gate: DecisionGate;
  label: string;
  roles: string[];
  mode: 'ALL' | 'ANY';
  appliesTo: 'ALL' | 'UNPLANNED';
  active: boolean;
}
export interface DecisionRow {
  gate: string;
  round: number;
  decision: Decision;
  roleCode: string;
  userId: number | null;
}

export function applicableSignoffs(rules: SignoffRule[], gate: Gate, classification: Classification): SignoffRule[] {
  return rules.filter((r) => r.active && r.gate === gate && (r.appliesTo === 'ALL' || classification === 'unplanned'));
}

/** Roles a sign-off still needs, given the approvals of the current round. */
export function missingRoles(rule: SignoffRule, approvals: DecisionRow[]): string[] {
  const approved = new Set(approvals.filter((d) => d.decision === 'approve').map((d) => d.roleCode));
  if (rule.mode === 'ANY') return rule.roles.some((r) => approved.has(r)) ? [] : rule.roles;
  return rule.roles.filter((r) => !approved.has(r));
}

export function gateSignedOff(rules: SignoffRule[], approvals: DecisionRow[]): boolean {
  return rules.length > 0 && rules.every((r) => missingRoles(r, approvals).length === 0);
}

/**
 * Gates whose approvers can't all be found: a role a sign-off depends on has nobody assigned (ALL: every role needs a
 * member; ANY: at least one of its roles). Shown as "No approver assigned for G_" until fixed.
 */
export function gatesWithoutApprovers(rules: SignoffRule[], membersByRole: Record<string, number>): DecisionGate[] {
  const out = new Set<DecisionGate>();
  for (const r of rules.filter((x) => x.active)) {
    const has = (role: string) => (membersByRole[role] ?? 0) > 0;
    const ok = r.mode === 'ALL' ? r.roles.every(has) : r.roles.some(has);
    if (!ok) out.add(r.gate);
  }
  return (['G1', 'G2', 'G3', 'G4', 'G5'] as DecisionGate[]).filter((g) => out.has(g));
}

// ------------------------------------------------------------------------------------------------ gate preconditions

/** What a gate's data rules look at (loaded by projectService for the project's current gate). */
export interface GateFacts {
  /** The latest scoring round, or null when the project has none. */
  latestScore: { total: number } | null;
  minScore: number;
  /** Required checklist items of this gate that are not done (or done without the evidence they need). */
  openChecklist: string[];
  teamSize: number;
  hasObjectives: boolean;
  hasTargetLaunchDate: boolean;
  labTests: number;
  fieldTrialsWithTsLead: number;
  /** Pilot batches within the kg range with QC, R&D and Production all confirmed. */
  confirmedBatches: number;
}

/** Every data rule a gate approval needs; empty = the data side is complete. */
export function gatePreconditionErrors(gate: Gate, f: GateFacts): PdpError[] {
  const errs: PdpError[] = [];
  const checklist = () => {
    if (f.openChecklist.length) errs.push(new PdpError('gate.checklistOpen', `Checklist items not done: ${f.openChecklist.join(', ')}.`, 'checklist'));
  };
  switch (gate) {
    case 'G1':
      if (!f.latestScore) errs.push(new PdpError('gate.scoreMissing', 'Score the project (all criteria with evidence) before G1.', 'scores'));
      else if (f.latestScore.total < f.minScore) {
        errs.push(new PdpError('gate.scoreBelowMin', `The score ${f.latestScore.total} is below the minimum ${f.minScore}: only reject or revise is possible.`, 'scores'));
      }
      checklist();
      if (f.teamSize === 0) errs.push(new PdpError('gate.teamRequired', 'Assign the project team before the kick-off.', 'team'));
      if (!f.hasObjectives) errs.push(new PdpError('gate.objectivesRequired', 'Define the objectives before the kick-off.', 'objectives'));
      if (!f.hasTargetLaunchDate) errs.push(new PdpError('gate.targetDateRequired', 'Set the target launch date before the kick-off.', 'targetLaunchDate'));
      break;
    case 'G2':
      if (f.labTests === 0) errs.push(new PdpError('gate.labTestRequired', 'Record at least one lab test before G2.', 'labTests'));
      checklist();
      break;
    case 'G3':
      if (f.fieldTrialsWithTsLead === 0) errs.push(new PdpError('gate.fieldTrialRequired', 'Record at least one field trial led by Technical Support before G3.', 'fieldTrials'));
      checklist();
      break;
    case 'G4':
      if (f.confirmedBatches === 0) {
        errs.push(new PdpError('gate.pilotRequired', 'Record a pilot batch within the kg range, confirmed by QC, R&D and Production, before G4.', 'pilotBatches'));
      }
      checklist();
      break;
    case 'G5':
      checklist();
      break;
    default:
      break;
  }
  return errs;
}

// ------------------------------------------------------------------------------------------------ capacity / freeze

export interface Capacity {
  active: number;
  max: number;
}

/**
 * One more active project (G1 approval, or on-hold -> active). Over the cap: only a CEO/EXCO, with a reason.
 * Returns true when the cap is overridden (the caller writes the reason to the history).
 */
export function checkCapacity(cap: Capacity, actingRoles: string[], overrideReason: unknown): boolean {
  if (cap.active + 1 <= cap.max) return false;
  const exec = actingRoles.some((r) => EXEC_ROLES.includes(r));
  if (!exec) {
    throw new PdpError('capacity.full', `${cap.active} of ${cap.max} projects are active: only the CEO or EXCO can approve over the limit.`, 'capacity', 409);
  }
  if (typeof overrideReason !== 'string' || !overrideReason.trim()) {
    throw new PdpError('capacity.reasonRequired', `${cap.active} of ${cap.max} projects are active: give the reason for going over the limit.`, 'overrideReason');
  }
  return true;
}

/** "MM-DD" -> comparable number, or null when empty/invalid. */
function mmdd(v: string | null | undefined): number | null {
  const m = /^(\d{2})-(\d{2})$/.exec((v ?? '').trim());
  if (!m) return null;
  const mo = Number(m[1]);
  const d = Number(m[2]);
  return mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? mo * 100 + d : null;
}

export function validFreezeValue(v: string): boolean {
  return v.trim() === '' || mmdd(v) !== null;
}

/** Is `today` (YYYY-MM-DD) inside the freeze? Empty from/to = no freeze. The range may wrap the year (11-15 .. 02-15). */
export function inFreeze(today: string, from: string | null | undefined, to: string | null | undefined): boolean {
  const a = mmdd(from);
  const b = mmdd(to);
  if (a === null || b === null) return false;
  const t = Number(today.slice(5, 7)) * 100 + Number(today.slice(8, 10));
  return a <= b ? t >= a && t <= b : t >= a || t <= b;
}

/** G0 -> G1: submitting is enough, except during the freeze (unplanned + a CEO/EXCO with a reason only). */
export function checkSubmit(p: { state: ProjectState; hasTreeLink: boolean; classification: Classification }, freezeActive: boolean, userRoles: string[], reason: unknown): { freezeOverride: boolean } {
  if (p.state !== 'draft') throw new PdpError('project.alreadySubmitted', 'This project has already been submitted.', undefined, 409);
  if (!p.hasTreeLink) throw new PdpError('project.treeLink', 'Link the project to a Product Tree product or propose a new product.', 'productId');
  if (!freezeActive) return { freezeOverride: false };
  if (p.classification !== 'unplanned') throw new PdpError('freeze.active', 'New requests are frozen for the peak season; only unplanned projects approved by the CEO or EXCO can be submitted.', 'classification', 409);
  if (!userRoles.some((r) => EXEC_ROLES.includes(r))) throw new PdpError('freeze.needsExec', 'During the peak-season freeze, an unplanned project must be submitted by the CEO or EXCO.', undefined, 403);
  if (typeof reason !== 'string' || !reason.trim()) throw new PdpError('freeze.reasonRequired', 'Give the reason for submitting during the freeze.', 'freezeReason');
  return { freezeOverride: true };
}

// ------------------------------------------------------------------------------------------------ decisions

export interface DecisionInput {
  project: { state: ProjectState; currentGate: Gate; gateRound: number; classification: Classification };
  decision: unknown;
  roleCode: unknown;
  comment: unknown;
  overrideReason?: unknown;
  /** Governance roles the deciding user holds. */
  userRoles: string[];
  rules: SignoffRule[];
  /** Decisions already taken at this gate in this round. */
  prior: DecisionRow[];
  facts: GateFacts;
  capacity: Capacity;
  userId: number;
}
export interface DecisionOutcome {
  decision: Decision;
  roleCode: string;
  gate: DecisionGate;
  /** approve: true when this approval completes the gate. */
  completesGate: boolean;
  capacityOverride: boolean;
}

/**
 * Validates one approve / reject / revise on the project's current gate. Gates are strictly sequential: a decision
 * always targets current_gate, so none can be skipped. The approver must hold a governance role the gate's sign-offs
 * need (the permission alone is not enough -- that is checked by the route).
 */
export function evaluateDecision(i: DecisionInput): DecisionOutcome {
  const { project } = i;
  if (project.state === 'draft') throw new PdpError('project.notSubmitted', 'Submit the request first (G0).', undefined, 409);
  if (project.state === 'on_hold') throw new PdpError('project.onHold', 'The project is on hold: resume it before deciding a gate.', undefined, 409);
  if (['rejected', 'launched', 'closed'].includes(project.state)) throw new PdpError('project.readOnly', 'This project has no open gate.', undefined, 409);
  if (project.currentGate === 'G0') throw new PdpError('project.notSubmitted', 'Submit the request first (G0).', undefined, 409);
  const gate = project.currentGate as DecisionGate;

  const decision = String(i.decision ?? '') as Decision;
  if (!DECISIONS.includes(decision)) throw new PdpError('decision.invalid', 'The decision must be approve, reject or revise.', 'decision');
  const roleCode = String(i.roleCode ?? '');
  if (!i.userRoles.includes(roleCode)) {
    throw new PdpError('decision.notMember', 'You do not hold this governance role, so you cannot decide as it.', 'roleCode', 403);
  }
  const signoffs = applicableSignoffs(i.rules, gate, project.classification);
  if (signoffs.length === 0) throw new PdpError('gate.noRules', `No sign-off is configured for ${gate}.`, undefined, 409);
  if (!signoffs.some((s) => s.roles.includes(roleCode))) {
    throw new PdpError('decision.roleNotRequired', `${gate} does not need a decision from this role.`, 'roleCode', 403);
  }
  const comment = typeof i.comment === 'string' ? i.comment.trim() : '';
  if ((decision === 'revise' || decision === 'reject') && !comment) {
    throw new PdpError('decision.commentRequired', decision === 'revise' ? 'Say what has to be revised.' : 'Give the reason for rejecting.', 'comment');
  }
  if (decision !== 'approve') return { decision, roleCode, gate, completesGate: false, capacityOverride: false };

  const approvals = i.prior.filter((d) => d.decision === 'approve');
  if (approvals.some((d) => d.roleCode === roleCode)) throw new PdpError('decision.duplicate', 'This role has already approved this gate.', 'roleCode', 409);
  const errs = gatePreconditionErrors(gate, i.facts);
  if (errs.length) throw errs[0];

  const after = [...approvals, { gate, round: project.gateRound, decision, roleCode, userId: i.userId }];
  const completesGate = gateSignedOff(signoffs, after);
  let capacityOverride = false;
  if (completesGate && gate === 'G1') capacityOverride = checkCapacity(i.capacity, [roleCode], i.overrideReason);
  return { decision, roleCode, gate, completesGate, capacityOverride };
}

/** State after a gate is fully approved. */
export function afterGateApproved(gate: DecisionGate): { currentGate: Gate; state: ProjectState } {
  if (gate === 'G5') return { currentGate: 'G5', state: 'launched' };
  return { currentGate: nextGate(gate) as Gate, state: 'active' };
}

// ------------------------------------------------------------------------------------------------ alerts

/** Fast-track: G1 feasibility must be done within `hours` of the G0 submission. */
export function fastTrackOverdue(p: { fastTrack: boolean; submittedAt: string | null; currentGate: Gate; state: ProjectState }, feasibilityDone: boolean, hours: number, now: Date): boolean {
  if (!p.fastTrack || !p.submittedAt || feasibilityDone || p.state !== 'submitted' || p.currentGate !== 'G1') return false;
  return now.getTime() - new Date(p.submittedAt).getTime() > hours * 3600_000;
}

// ------------------------------------------------------------------------------------------------ KPIs

export type KpiCode = 'NEW_PRODUCTS' | 'REFORMULATIONS' | 'FIELD_TRIAL_SUCCESS' | 'FIRST_PASS_LAB' | 'ON_TIME' | 'CYCLE_TIME' | 'CRITICAL_DOC_ERRORS';
export interface KpiTarget {
  kpi_code: string;
  label: string;
  target: number;
  comparator: 'gte' | 'lte' | 'eq';
  unit: 'count' | 'pct' | 'days';
}
export interface KpiFacts {
  /** Projects approved at G5. launchedAt / submittedAt / targetLaunchDate are YYYY-MM-DD (business dates). */
  launches: { projectId: number; classification: Classification; launchedAt: string; submittedAt: string | null; targetLaunchDate: string | null }[];
  fieldTrials: { projectId: number; date: string; passed: boolean }[];
  labTests: { projectId: number; trialNo: number; date: string; passed: boolean }[];
  docErrors: { projectId: number; severity: 'critical' | 'minor'; foundDate: string }[];
}
export interface KpiTile {
  code: string;
  label: string;
  value: number | null;
  target: number;
  comparator: KpiTarget['comparator'];
  unit: KpiTarget['unit'];
  /** green = meets the target, red = misses it, none = no data in the period. */
  status: 'green' | 'red' | 'none';
  numerator: number | null;
  denominator: number | null;
  projectIds: number[];
}

/** "2026-Q4" -> first and last day. */
export function quarterRange(q: string): { from: string; to: string } {
  const m = /^(\d{4})-Q([1-4])$/.exec(q);
  if (!m) throw new PdpError('kpi.quarter', 'The quarter must look like 2026-Q4.', 'quarter');
  const y = Number(m[1]);
  const n = Number(m[2]);
  const startMonth = (n - 1) * 3 + 1;
  const endMonth = startMonth + 2;
  const lastDay = new Date(Date.UTC(y, endMonth, 0)).getUTCDate();
  return { from: `${y}-${String(startMonth).padStart(2, '0')}-01`, to: `${y}-${String(endMonth).padStart(2, '0')}-${lastDay}` };
}

export function quarterOf(date: string): string {
  return `${date.slice(0, 4)}-Q${Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1}`;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400_000);
}

function meets(value: number, t: KpiTarget): boolean {
  if (t.comparator === 'gte') return value >= t.target;
  if (t.comparator === 'lte') return value <= t.target;
  return value === t.target;
}

/**
 * The seven policy KPIs over [from, to] (inclusive, YYYY-MM-DD):
 *  NEW_PRODUCTS        G5 approvals with classification <> reformulation
 *  REFORMULATIONS      G5 approvals with classification = reformulation
 *  FIELD_TRIAL_SUCCESS passed trials / all trials dated in the period, %
 *  FIRST_PASS_LAB      projects whose first lab trial (trial 1) passed every target / projects with a trial 1 in the
 *                      period (dated by its first test), %
 *  ON_TIME             launched on or before target_launch_date / launched in the period, % (no target = late)
 *  CYCLE_TIME          average days from G0 submission to G5 approval, launches in the period
 *  CRITICAL_DOC_ERRORS critical documentation errors found in the period
 */
export function computeKpis(f: KpiFacts, targets: KpiTarget[], from: string, to: string): KpiTile[] {
  const inP = (d: string | null) => d !== null && d >= from && d <= to;
  const launches = f.launches.filter((l) => inP(l.launchedAt));
  const pct = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 1000) / 10);

  const values: Record<KpiCode, { value: number | null; num: number | null; den: number | null; ids: number[] }> = {
    NEW_PRODUCTS: (() => {
      const l = launches.filter((x) => x.classification !== 'reformulation');
      return { value: l.length, num: l.length, den: null, ids: l.map((x) => x.projectId) };
    })(),
    REFORMULATIONS: (() => {
      const l = launches.filter((x) => x.classification === 'reformulation');
      return { value: l.length, num: l.length, den: null, ids: l.map((x) => x.projectId) };
    })(),
    FIELD_TRIAL_SUCCESS: (() => {
      const t = f.fieldTrials.filter((x) => inP(x.date));
      const passed = t.filter((x) => x.passed).length;
      return { value: pct(passed, t.length), num: passed, den: t.length, ids: [...new Set(t.map((x) => x.projectId))] };
    })(),
    FIRST_PASS_LAB: (() => {
      const first = new Map<number, { date: string; allPassed: boolean }>();
      for (const t of f.labTests.filter((x) => x.trialNo === 1)) {
        const cur = first.get(t.projectId);
        first.set(t.projectId, { date: cur && cur.date < t.date ? cur.date : t.date, allPassed: (cur?.allPassed ?? true) && t.passed });
      }
      const inPeriod = [...first.entries()].filter(([, v]) => inP(v.date));
      const ok = inPeriod.filter(([, v]) => v.allPassed).length;
      return { value: pct(ok, inPeriod.length), num: ok, den: inPeriod.length, ids: inPeriod.map(([id]) => id) };
    })(),
    ON_TIME: (() => {
      const ok = launches.filter((x) => x.targetLaunchDate !== null && x.launchedAt <= x.targetLaunchDate).length;
      return { value: pct(ok, launches.length), num: ok, den: launches.length, ids: launches.map((x) => x.projectId) };
    })(),
    CYCLE_TIME: (() => {
      const l = launches.filter((x) => x.submittedAt);
      if (l.length === 0) return { value: null, num: null, den: 0, ids: [] };
      const total = l.reduce((s, x) => s + daysBetween(x.submittedAt as string, x.launchedAt), 0);
      return { value: Math.round((total / l.length) * 10) / 10, num: total, den: l.length, ids: l.map((x) => x.projectId) };
    })(),
    CRITICAL_DOC_ERRORS: (() => {
      const e = f.docErrors.filter((x) => x.severity === 'critical' && inP(x.foundDate));
      return { value: e.length, num: e.length, den: null, ids: [...new Set(e.map((x) => x.projectId))] };
    })(),
  };

  return targets.map((t) => {
    const v = values[t.kpi_code as KpiCode];
    const value = v ? v.value : null;
    // Counts are always measurable (0 is a value); a rate with an empty denominator has no data.
    const status: KpiTile['status'] = value === null ? 'none' : meets(value, t) ? 'green' : 'red';
    return {
      code: t.kpi_code, label: t.label, value, target: Number(t.target), comparator: t.comparator, unit: t.unit, status,
      numerator: v?.num ?? null, denominator: v?.den ?? null, projectIds: v?.ids ?? [],
    };
  });
}

/** Active projects by classification vs the 50/30/20 target (a warning only, never a block). */
export function projectMix(active: Classification[], targets: { planned: number; unplanned: number; innovation: number }) {
  const n = active.length;
  const share = (c: Classification) => (n === 0 ? 0 : Math.round((active.filter((x) => x === c).length / n) * 1000) / 10);
  const rows = (['planned', 'unplanned', 'innovation'] as const).map((c) => ({
    classification: c, count: active.filter((x) => x === c).length, pct: share(c), target: targets[c],
  }));
  const reformulation = active.filter((x) => x === 'reformulation').length;
  // A gap of more than 10 points from a target share is flagged.
  const warning = n > 0 && rows.some((r) => Math.abs(r.pct - r.target) > 10);
  return { total: n, rows, reformulation, warning };
}
