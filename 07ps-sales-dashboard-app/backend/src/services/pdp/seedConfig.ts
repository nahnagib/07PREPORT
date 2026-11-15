import type { Db } from './db';
import { exec } from './db';

/**
 * The configuration migration 0076 seeds, for databases where TIKA reached dim_company only after 0076 ran: the admin
 * import calls ensureConfigSeed first. INSERT IGNORE on the natural keys, so it never overwrites an admin's edit.
 * Keep in step with data/warehouse/migrations/0076_pdp_seed_config.sql (__tests__/seedConfig.test.ts compares them).
 */

export const SEED_SETTINGS: [string, string][] = [
  ['max_concurrent_projects', '6'],
  ['mix_target_planned', '50'],
  ['mix_target_unplanned', '30'],
  ['mix_target_innovation', '20'],
  ['min_score', '60'],
  ['fast_track_feasibility_hours', '72'],
  ['freeze_from_mmdd', ''],
  ['freeze_to_mmdd', ''],
  ['pilot_kg_min', '500'],
  ['pilot_kg_max', '1500'],
];

export const SEED_GOVERNANCE_ROLES: [string, string, string][] = [
  ['CHAIRMAN', 'Chairman', 'Kick-off approval (with the CEO).'],
  ['CEO', 'CEO', 'Product portfolio leadership; kick-off approval; unplanned-project and capacity overrides.'],
  ['EXCO', 'EXCO', 'Strategic oversight, final approval.'],
  ['TECH_MANAGER', 'Technical Manager', 'Full ownership of the development pipeline.'],
  ['RND', 'R&D', 'Formulation, benchmarking, documentation.'],
  ['TS', 'Technical Support', 'Field trials, performance validation.'],
  ['COMMERCIAL', 'Commercial', 'Market demand, competitor insights, pricing.'],
  ['MARKETING', 'Marketing', 'Packaging, naming, branding.'],
  ['QC_QA', 'QC/QA', 'Standards compliance.'],
  ['PRODUCTION', 'Production', 'Scale-up and manufacturability.'],
];

export interface SeedCriterion {
  code: string;
  name: string;
  weight: number;
  meanings: [string, string, string, string, string, string];
}

export const SEED_CRITERIA: SeedCriterion[] = [
  { code: 'STRATEGIC_ALIGNMENT', name: 'Strategic Alignment', weight: 20, meanings: ['No alignment with strategy', 'Very weak alignment', 'Limited or partial alignment', 'Good alignment with one pillar', 'Strong alignment with key pillars', 'Critical strategic priority'] },
  { code: 'REVENUE_POTENTIAL', name: 'Revenue Potential', weight: 20, meanings: ['No commercial value', 'Very small potential', 'Moderate potential', 'Good commercial return expected', 'High revenue potential', 'Major revenue generator'] },
  { code: 'TECHNICAL_RISK', name: 'Technical Risk', weight: 20, meanings: ['Very high risk – likely to fail', 'High risk – sensitive to conditions', 'Medium-high risk – requires controls', 'Moderate risk – manageable', 'Low risk', 'Very low risk – highly stable'] },
  { code: 'DEVELOPMENT_DIFFICULTY', name: 'Development Difficulty', weight: 20, meanings: ['Very difficult – advanced chemistry', 'High difficulty – many iterations', 'Medium-high difficulty', 'Moderate difficulty', 'Low difficulty', 'Very easy – straightforward formula'] },
  { code: 'URGENCY', name: 'Urgency', weight: 10, meanings: ['Not urgent', 'Low urgency', 'Moderate urgency', 'Needed this quarter', 'High urgency', 'Immediate need for active project'] },
  { code: 'PRODUCTION_IMPACT', name: 'Production Impact', weight: 10, meanings: ['Major changes or new machinery needed', 'High impact on production', 'Medium-high impact', 'Moderate impact', 'Low impact', 'No impact on production'] },
];

export const SEED_GATE_RULES: [string, string, string, string[], 'ALL' | 'ANY', 'ALL' | 'UNPLANNED'][] = [
  ['G1', 'KICKOFF', 'Kick-off approval (Chairman / CEO)', ['CHAIRMAN', 'CEO'], 'ANY', 'ALL'],
  ['G1', 'UNPLANNED_EXEC', 'Unplanned project approval (CEO / EXCO)', ['CEO', 'EXCO'], 'ANY', 'UNPLANNED'],
  ['G2', 'TECH_EVAL', 'Technical evaluation (R&D + QC/QA + Production)', ['RND', 'QC_QA', 'PRODUCTION'], 'ALL', 'ALL'],
  ['G3', 'TS_VALIDATION', 'Pre-launch validation (Technical Support)', ['TS'], 'ANY', 'ALL'],
  ['G4', 'PILOT', 'Pilot sign-off (Technical Manager)', ['TECH_MANAGER'], 'ANY', 'ALL'],
  ['G5', 'FINAL_LAUNCH', 'Final launch approval (EXCO)', ['EXCO'], 'ANY', 'ALL'],
];

/** [list, item_code, label, hint, gate, required, needs_evidence, owner role, sort] */
export const SEED_CHECKLIST: [string, string, string, string | null, string, 0 | 1, 0 | 1, string, number][] = [
  ['FEASIBILITY', 'FEAS_RAW_MATERIAL', 'Raw material qualification', null, 'G1', 1, 0, 'RND', 1],
  ['FEASIBILITY', 'FEAS_EQUIPMENT', 'Equipment capability', null, 'G1', 1, 0, 'PRODUCTION', 2],
  ['FEASIBILITY', 'FEAS_COST', 'Cost structure analysis', null, 'G1', 1, 0, 'COMMERCIAL', 3],
  ['FEASIBILITY', 'FEAS_STANDARDS', 'Standards mapping (EN/ASTM)', null, 'G1', 1, 0, 'QC_QA', 4],
  ['FEASIBILITY', 'FEAS_MARKET', 'Market availability', null, 'G1', 1, 0, 'COMMERCIAL', 5],
  ['FEASIBILITY', 'FEAS_RISKS', 'Risks & mitigation', null, 'G1', 1, 0, 'TECH_MANAGER', 6],
  ['RAW_MATERIAL', 'RM_PURITY', 'Purity', 'Joint QC & R&D evaluation', 'G4', 1, 0, 'QC_QA', 11],
  ['RAW_MATERIAL', 'RM_MOISTURE', 'Moisture', 'Joint QC & R&D evaluation', 'G4', 1, 0, 'QC_QA', 12],
  ['RAW_MATERIAL', 'RM_PARTICLE_SIZE', 'Particle size', 'Joint QC & R&D evaluation', 'G4', 1, 0, 'QC_QA', 13],
  ['RAW_MATERIAL', 'RM_COMPATIBILITY', 'Compatibility', 'Joint QC & R&D evaluation', 'G4', 1, 0, 'RND', 14],
  ['RAW_MATERIAL', 'RM_STABILITY', 'Stability', 'Joint QC & R&D evaluation', 'G4', 1, 0, 'RND', 15],
  ['RAW_MATERIAL', 'RM_COST_EFFICIENCY', 'Cost efficiency', 'Joint QC & R&D evaluation', 'G4', 1, 0, 'RND', 16],
  ['DOCUMENTATION', 'DOC_TDS', 'TDS (Technical Data Sheet)', null, 'G5', 1, 1, 'RND', 21],
  ['DOCUMENTATION', 'DOC_MSDS', 'MSDS (Material Safety Data Sheet)', null, 'G5', 1, 1, 'RND', 22],
  ['DOCUMENTATION', 'DOC_FORMULA', 'Final formula', null, 'G5', 1, 1, 'RND', 23],
  ['DOCUMENTATION', 'DOC_QC_SPECS', 'QC specifications', null, 'G5', 1, 1, 'QC_QA', 24],
  ['DOCUMENTATION', 'DOC_SOP', 'Production SOP', null, 'G5', 1, 1, 'PRODUCTION', 25],
  ['DOCUMENTATION', 'DOC_MOS', 'Method of Statement', null, 'G5', 1, 1, 'TS', 26],
  ['DOCUMENTATION', 'DOC_CERTS', 'Compliance certificates', null, 'G5', 1, 1, 'QC_QA', 27],
  ['DOCUMENTATION', 'DOC_PACKAGING', 'Packaging development', 'Artwork, regulatory compliance, brand consistency, TDS/MSDS match (policy section 13)', 'G5', 0, 1, 'MARKETING', 28],
];

export const SEED_KPI_TARGETS: [string, string, number, 'gte' | 'lte' | 'eq', 'count' | 'pct' | 'days'][] = [
  ['NEW_PRODUCTS', 'New products this quarter', 3, 'gte', 'count'],
  ['REFORMULATIONS', 'Reformulations this quarter', 2, 'gte', 'count'],
  ['FIELD_TRIAL_SUCCESS', 'Field-trial success', 80, 'gte', 'pct'],
  ['FIRST_PASS_LAB', 'First-pass lab success', 85, 'gte', 'pct'],
  ['ON_TIME', 'On-time delivery', 90, 'gte', 'pct'],
  ['CYCLE_TIME', 'Average cycle time', 60, 'lte', 'days'],
  ['CRITICAL_DOC_ERRORS', 'Critical documentation errors', 0, 'lte', 'count'],
];

export const SEED_ROADMAP_YEARS: [number, string][] = [
  [2023, 'Foundation Year'],
  [2024, 'Expansion Year'],
  [2025, 'Transformation Year'],
  [2026, 'Portfolio Year'],
  [2027, 'Optimization Year'],
  [2028, 'Innovation & Advanced Systems Year'],
];

export const SEED_GAP_ITEMS: [string, string, string][] = [
  ['MANPOWER', 'Technical Support Dept.', 'open'],
  ['MANPOWER', 'R&D technicians', 'open'],
  ['MANPOWER', 'Sales team upskilling', 'open'],
  ['MANPOWER', 'R&D committee', 'open'],
  ['MANPOWER', 'Production team', 'open'],
  ['MACHINE', 'Production lines ready for 2026 plan', 'open'],
  ['MACHINE', 'Lab equipment', 'open'],
  ['MACHINE', 'Extension for residential buildings', 'open'],
  ['MATERIALS', 'Suppliers: Libya, Spain, China, Turkey and Egypt', 'open'],
  ['MATERIALS', 'Trading items suppliers', 'open'],
  ['METHODS', 'R&D policy, forms and SOP', 'open'],
  ['MEASUREMENTS', 'R&D KPIs', 'open'],
  ['MEASUREMENTS', 'Monitoring tools (product launch tracking, dashboard & customer feedback)', 'in_progress'],
];

export const SEED_DROPDOWNS: [string, string][] = [
  ['project_type', 'New Product Development (NPD)'],
  ['project_type', 'Product Improvement / Optimization'],
  ['project_type', 'Localization & Cost Optimization'],
  ['project_type', 'Technical Support–initiated Improvement'],
  ['project_type', 'Sales/Market Demand Request'],
  ['request_source', 'Sales'],
  ['request_source', 'Technical Support'],
  ['request_source', 'R&D'],
  ['request_source', 'QC'],
  ['request_source', 'Commercial'],
  ['request_source', 'Employee idea'],
  ['competitor', 'Sika'],
  ['competitor', 'Mapei'],
  ['competitor', 'Weber'],
  ['competitor', 'Other'],
  ['lab_property', 'Adhesion'],
  ['lab_property', 'Strength'],
  ['lab_property', 'Flexibility'],
  ['lab_property', 'Curing'],
  ['lab_property', 'Workability'],
  ['lab_property', 'Climatic performance'],
  ['feedback_channel', 'Site visit'],
  ['feedback_channel', 'Phone'],
  ['feedback_channel', 'WhatsApp'],
  ['feedback_channel', 'Email'],
  ['feedback_channel', 'Sales visit'],
  ['feedback_category', 'Performance'],
  ['feedback_category', 'Application'],
  ['feedback_category', 'Packaging'],
  ['feedback_category', 'Price'],
  ['feedback_category', 'Other'],
];

/** Inserts whatever of the seed is missing; returns how many rows were added. */
export async function ensureConfigSeed(db: Db, ck: number): Promise<number> {
  let added = 0;
  const add = async (sql: string, params: unknown[]) => {
    added += (await exec(db, sql, params)).affectedRows;
  };
  for (const [k, v] of SEED_SETTINGS) await add('INSERT IGNORE INTO pdp_setting (company_key, setting_key, setting_value) VALUES (?, ?, ?)', [ck, k, v]);
  for (const [i, [code, label, resp]] of SEED_GOVERNANCE_ROLES.entries()) {
    await add('INSERT IGNORE INTO pdp_governance_role (company_key, code, label, responsibility, sort_order) VALUES (?, ?, ?, ?, ?)', [ck, code, label, resp, i + 1]);
  }
  for (const [i, c] of SEED_CRITERIA.entries()) {
    await add(
      `INSERT IGNORE INTO pdp_scoring_criterion (company_key, code, name, weight, meaning_0, meaning_1, meaning_2, meaning_3, meaning_4, meaning_5, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ck, c.code, c.name, c.weight, ...c.meanings, i + 1],
    );
  }
  for (const [i, [gate, code, label, roles, mode, applies]] of SEED_GATE_RULES.entries()) {
    await add(
      'INSERT IGNORE INTO pdp_gate_rule (company_key, gate, signoff_code, label, roles_json, mode, applies_to, sort_order) VALUES (?, ?, ?, ?, CAST(? AS JSON), ?, ?, ?)',
      [ck, gate, code, label, JSON.stringify(roles), mode, applies, i + 1],
    );
  }
  for (const [list, code, label, hint, gate, req, ev, owner, so] of SEED_CHECKLIST) {
    await add(
      `INSERT IGNORE INTO pdp_checklist_template (company_key, list_code, item_code, label, hint, gate, required, needs_evidence, owner_role_code, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ck, list, code, label, hint, gate, req, ev, owner, so],
    );
  }
  for (const [i, [code, label, t, cmp, unit]] of SEED_KPI_TARGETS.entries()) {
    await add('INSERT IGNORE INTO pdp_kpi_target (company_key, kpi_code, label, target, comparator, unit, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)', [ck, code, label, t, cmp, unit, i + 1]);
  }
  for (const [y, theme] of SEED_ROADMAP_YEARS) await add('INSERT IGNORE INTO pdp_roadmap_year (company_key, year, theme) VALUES (?, ?, ?)', [ck, y, theme]);
  for (const [i, [cat, item, st]] of SEED_GAP_ITEMS.entries()) {
    await add('INSERT IGNORE INTO pdp_gap_item (company_key, category, item, status, sort_order) VALUES (?, ?, ?, ?, ?)', [ck, cat, item, st, i + 1]);
  }
  const sortByList = new Map<string, number>();
  for (const [list, label] of SEED_DROPDOWNS) {
    const so = (sortByList.get(list) ?? 0) + 1;
    sortByList.set(list, so);
    await add('INSERT IGNORE INTO pdp_dropdown_value (company_key, list_key, label, sort_order) VALUES (?, ?, ?, ?)', [ck, list, label, so]);
  }
  return added;
}
